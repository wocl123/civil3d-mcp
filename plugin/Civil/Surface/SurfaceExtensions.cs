using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class SurfaceExtensions
{
    internal static string FileDigest(JsonObject r, string key, params string[] extensions)
    {
        string path = CivilObjectAccess.Text(r, key);
        if (!Path.IsPathFullyQualified(path) || !File.Exists(path) || !extensions.Contains(Path.GetExtension(path).ToLowerInvariant()))
            throw new ArgumentException("존재하는 파일의 절대 경로와 지원 확장자를 지정하세요.");
        FileInfo info = new(path);
        if (info.Length > 256 * 1024 * 1024) throw new ArgumentException("파일 검증 한도 256MiB를 초과했습니다.");
        using FileStream input = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        r[key] = Path.GetFullPath(path);
        return Convert.ToHexString(SHA256.HashData(input));
    }
    internal static string GeometryDigest(TinSurface s)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (TinSurfaceVertex v in s.Vertices)
        {
            Point3d p = v.Location;
            hash.AppendData(Encoding.UTF8.GetBytes(string.Create(CultureInfo.InvariantCulture, $"{p.X:R},{p.Y:R},{p.Z:R};")));
        }
        foreach (SurfaceOperation op in Enumerable.Range(0, s.Operations.Count).Select(i => s.Operations[i])) hash.AppendData(Encoding.UTF8.GetBytes(op.GetType().Name));
        return Convert.ToHexString(hash.GetHashAndReset());
    }
    private static bool DependsOn(TinSurface source, ObjectId target, Transaction tr, HashSet<ObjectId> visited)
    {
        if (source.ObjectId == target) return true;
        if (!visited.Add(source.ObjectId)) return false;
        return Enumerable.Range(0, source.Operations.Count).Select(i => source.Operations[i]).OfType<SurfaceOperationPasteSurface>().Any(p => p.SurfaceId == target ||
            tr.GetObject(p.SurfaceId, OpenMode.ForRead) is TinSurface s && DependsOn(s, target, tr, visited));
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string action = CivilObjectAccess.Text(r, "action");
        if (action == "landxml")
        {
            r["fileDigest"] = FileDigest(r, "path", ".xml", ".landxml");
            CivilObjectAccess.FreeName<Autodesk.Civil.DatabaseServices.Surface>(tr, db, CivilObjectAccess.Text(r, "name"));
            string requested = CivilObjectAccess.Text(r, "xmlSurface");
            using XmlReader reader = XmlReader.Create(CivilObjectAccess.Text(r, "path"), new XmlReaderSettings {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 256L * 1024 * 1024 });
            reader.MoveToContent();
            if (reader.LocalName != "LandXML") throw new ArgumentException("LandXML 문서가 아닙니다.");
            string? unit = null; bool found = false;
            while (reader.Read())
            {
                if (reader.NodeType != XmlNodeType.Element) continue;
                if (reader.LocalName is "Metric" or "Imperial") unit = reader.GetAttribute("linearUnit");
                if (reader.LocalName == "Surface" && reader.GetAttribute("name") == requested) found = true;
            }
            if (!found) throw new ArgumentException("파일에 지정한 이름의 지표면이 없습니다.");
            string drawingUnits = CivilCoordinates.Read(db).CivilUnits;
            if (!(drawingUnits == "Meters" && unit == "meter" || drawingUnits == "Feet" && unit == "foot"))
                throw new ArgumentException("LandXML의 선형 단위와 Civil 도면 단위가 일치해야 합니다. 단위를 명시적으로 맞춘 파일을 사용하세요.");
            r["fileUnits"] = unit;
            PrimitiveAccess.Layer(db, tr, r);
            details.Add("LandXML의 명시한 지표면을 가져옵니다. 파일 좌표계를 자동 변환하지 않습니다.");
        }
        else
        {
            TinSurface s = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface"));
            CivilObjectAccess.Editable(s); PrimitiveAccess.Writable(db, tr, s);
            r["surface"] = s.Handle.ToString(); r["surfaceDigest"] = GeometryDigest(s);
            details.Add($"TIN 지표면 {s.Name} [{s.Handle}]: {action}. 연결된 종단·토량·코리더·횡단이 갱신될 수 있습니다.");
            if (action == "paste")
            {
                TinSurface source = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "sourceSurface"));
                if (DependsOn(source, s.ObjectId, tr, new HashSet<ObjectId>())) throw new ArgumentException("자기 자신 또는 순환 붙여넣기 참조를 만들 수 없습니다.");
                r["sourceSurface"] = source.Handle.ToString(); r["sourceDigest"] = GeometryDigest(source);
            }
            else if (action == "contours")
            {
                var entities = PrimitiveAccess.Targets<Polyline>(db, tr, r);
                r["contourState"] = new JsonArray(entities.Select(GeometryEditing.Snapshot).ToArray());
                foreach (string key in new[] { "midOrdinate", "maximumDistance", "weedingDistance", "weedingAngle" })
                    if (CivilObjectAccess.Number(r[key]) < 0) throw new ArgumentException("등고선 생성 옵션은 음수가 될 수 없습니다.");
                if (CivilObjectAccess.Number(r["midOrdinate"]) <= 0) throw new ArgumentException("중간 종거 거리는 양수입니다.");
            }
            else if (action == "dem") r["fileDigest"] = FileDigest(r, "path", ".dem", ".tif", ".tiff", ".asc", ".adf");
            else if (action is "swapEdge" or "deleteEdge")
            {
                var edge = s.FindEdgeAtXY(CivilObjectAccess.Number(r["x"]), CivilObjectAccess.Number(r["y"]));
                if (!edge.IsValid || edge.IsLocked) throw new ArgumentException("선택한 삼각망 모서리가 유효하지 않거나 잠겼습니다.");
                r["edgeState"] = new JsonArray(PrimitiveAccess.JsonPoint(edge.Vertex1.Location), PrimitiveAccess.JsonPoint(edge.Vertex2.Location));
            }
            else if (action == "boundary")
            {
                Point3d[] pts = GeometryExtensions.Points(r, "points", 3);
                if (pts[0].DistanceTo(pts[^1]) > 1e-8) throw new ArgumentException("경계는 첫 점과 마지막 점을 같게 지정하세요.");
                if (!Enum.TryParse<SurfaceBoundaryType>(CivilObjectAccess.Text(r, "boundaryType"), out var type) || !Enum.IsDefined(type)) throw new ArgumentException("경계 종류가 잘못됐습니다.");
                if (CivilObjectAccess.Number(r["midOrdinate"]) <= 0) throw new ArgumentException("중간 종거 거리는 양수입니다.");
            }
            else if (action == "removeBoundary")
            {
                int index = r["index"]?.GetValue<int>() ?? -1;
                if (index < 0 || index >= s.BoundariesDefinition.Count) throw new ArgumentException("경계 정의 인덱스를 확인하세요.");
                details.Add($"경계 정의 {index}: {s.BoundariesDefinition[index].Name} 제거");
            }
            else if (action == "simplify")
            {
                double percentage = CivilObjectAccess.Number(r["percentage"]);
                if (percentage <= 0 || percentage >= 100 || CivilObjectAccess.Number(r["maximumElevationChange"]) <= 0) throw new ArgumentException("제거 비율은 0~100% 사이, 최대 표고 변화는 양수입니다.");
                details.Add("지표면 정점을 제거하여 단순화합니다. 지형의 정확도가 달라지므로 비율과 최대 표고 변화량을 확인하세요.");
            }
            else if (action == "extractContours")
            {
                if (CivilObjectAccess.Number(r["interval"]) <= 0 || CivilObjectAccess.Number(r["elevationMin"]) >= CivilObjectAccess.Number(r["elevationMax"])) throw new ArgumentException("등고 간격·표고 범위를 확인하세요.");
                if ((CivilObjectAccess.Number(r["elevationMax"]) - CivilObjectAccess.Number(r["elevationMin"])) / CivilObjectAccess.Number(r["interval"]) > 1000) throw new ArgumentException("추출 등고 단계는 1000개 이하입니다.");
                PrimitiveAccess.Layer(db, tr, r);
            }
            else throw new ArgumentException("알 수 없는 지표면 정의 작업입니다.");
        }
        details.AddRange(CivilPlanDetails.Describe(r)); return "지표면 " + CivilPlanDetails.Action(action);
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string action = CivilObjectAccess.Text(r, "action");
        if (action == "landxml")
        {
            ObjectId id = TinSurface.CreateFromLandXML(db, CivilObjectAccess.Text(r, "name"), CivilObjectAccess.Text(r, "path"), CivilObjectAccess.Text(r, "xmlSurface"));
            ((TinSurface)tr.GetObject(id, OpenMode.ForWrite)).LayerId = PrimitiveAccess.Layer(db, tr, r);
            return new { handle = id.Handle.ToString() };
        }
        TinSurface s = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface")); s.UpgradeOpen();
        switch (action)
        {
            case "paste": s.PasteSurface(CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "sourceSurface")).ObjectId); break;
            case "contours": s.ContoursDefinition.AddContours(new ObjectIdCollection(((JsonArray)r["handles"]!).Select(h => CivilObjectAccess.ByHandle(tr, db, h!.ToString()).ObjectId).ToArray()),
                CivilObjectAccess.Number(r["midOrdinate"]), CivilObjectAccess.Number(r["maximumDistance"]), CivilObjectAccess.Number(r["weedingDistance"]), CivilObjectAccess.Number(r["weedingAngle"])); break;
            case "dem": s.DEMFilesDefinition.AddDEMFile(CivilObjectAccess.Text(r, "path")); break;
            case "swapEdge": s.SwapEdge(s.FindEdgeAtXY(CivilObjectAccess.Number(r["x"]), CivilObjectAccess.Number(r["y"]))); break;
            case "deleteEdge": s.DeleteLine(s.FindEdgeAtXY(CivilObjectAccess.Number(r["x"]), CivilObjectAccess.Number(r["y"]))); break;
            case "boundary": s.BoundariesDefinition.AddBoundaries(new Point3dCollection(GeometryExtensions.Points(r, "points", 3)), CivilObjectAccess.Number(r["midOrdinate"]), Enum.Parse<SurfaceBoundaryType>(CivilObjectAccess.Text(r, "boundaryType")), true); break;
            case "removeBoundary": s.BoundariesDefinition.RemoveAt(r["index"]!.GetValue<int>()); break;
            case "simplify":
                var options = new SurfaceSimplifyOptions(SurfaceSimplifyType.PointRemoval) { UsePercentageToRemove = true, PercentageToRemove = CivilObjectAccess.Number(r["percentage"]),
                    UseMaximumChangeInElevation = true, MaximumChangeInElevation = CivilObjectAccess.Number(r["maximumElevationChange"]) };
                options.SetSurfaceBorderAsRegion(); s.SimplifySurface(options); break;
            case "extractContours":
                var contours = s.ExtractContours(CivilObjectAccess.Number(r["elevationMin"]), CivilObjectAccess.Number(r["elevationMax"]), CivilObjectAccess.Number(r["interval"]));
                foreach (ObjectId id in contours) ((Autodesk.AutoCAD.DatabaseServices.Entity)tr.GetObject(id, OpenMode.ForWrite)).LayerId = PrimitiveAccess.Layer(db, tr, r);
                return new { created = contours.Cast<ObjectId>().Select(id => id.Handle.ToString()).ToArray() };
        }
        s.Rebuild(); return new { name = s.Name, handle = s.Handle.ToString() };
    }
}
