using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class FeatureLineChanges
{
    internal static T Find<T>(Database db, Transaction tr, string key) where T : Autodesk.Civil.DatabaseServices.Entity
    {
        T[] items = PrimitiveAccess.Entities(db, tr, true).OfType<T>().ToArray();
        T[] found = items.Where(e => e.Handle.ToString().Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (found.Length == 0) found = items.Where(e => e.Name.Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (found.Length != 1) throw new ArgumentException($"{typeof(T).Name} '{key}' 대상이 없거나 중복됩니다. 핸들을 사용하세요.");
        return found[0];
    }

    public static object List(Document doc, int offset, int limit)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        var lines = PrimitiveAccess.Entities(doc.Database, tr, true).OfType<FeatureLine>().OrderBy(e => e.Name).ToArray();
        return new { total = lines.Length, offset, hasMore = offset + limit < lines.Length,
            items = lines.Skip(offset).Take(limit).Select(e => new { name = e.Name, handle = e.Handle.ToString(),
                e.Layer, e.Description, e.Length2D, e.Length3D, e.MinElevation, e.MaxElevation,
                points = e.GetPoints(FeatureLinePointType.AllPoints).Cast<Point3d>().Select(PrimitiveAccess.JsonPoint).ToArray() }).ToArray() };
    }

    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        bool create = CivilObjectAccess.Text(r, "operation") == "featureLine.create";
        FeatureLine? line = null;
        if (create)
        {
            string name = CivilObjectAccess.Text(r, "name");
            SymbolUtilityServices.ValidateSymbolName(name, false);
            if (PrimitiveAccess.Entities(db, tr, true).OfType<FeatureLine>().Any(e => e.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("형상선 이름이 이미 있습니다.");
            var source = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source"));
            if (source is not (Line or Arc or Polyline or Polyline2d or Polyline3d))
                throw new ArgumentException("선·호·2D/3D 폴리선으로 형상선을 만드세요.");
            PrimitiveAccess.Writable(db, tr, source);
            r["source"] = source.Handle.ToString();
            details.Add($"원본 {source.GetType().Name} [{source.Handle}] → 형상선 {name}. 원본은 보존합니다.");
            if (source is Polyline3d p3)
                r["sourceState"] = new JsonArray(p3.Cast<ObjectId>().Select(id =>
                    PrimitiveAccess.JsonPoint(((PolylineVertex3d)tr.GetObject(id, OpenMode.ForRead)).Position)).ToArray());
            else if (source is Polyline2d p2)
                r["sourceState"] = new JsonArray(p2.Cast<ObjectId>().Select(id =>
                    PrimitiveAccess.JsonPoint(((Vertex2d)tr.GetObject(id, OpenMode.ForRead)).Position)).ToArray());
            else r["sourceState"] = GeometryEditing.Snapshot(source);
        }
        else
        {
            line = Find<FeatureLine>(db, tr, CivilObjectAccess.Text(r, "featureLine"));
            CivilObjectAccess.Editable(line); PrimitiveAccess.Writable(db, tr, line);
            r["featureLine"] = line.Handle.ToString();
            r["sourceState"] = new JsonObject { ["name"] = line.Name, ["description"] = line.Description,
                ["layer"] = line.Layer, ["style"] = line.StyleId.Handle.ToString(),
                ["points"] = new JsonArray(line.GetPoints(FeatureLinePointType.AllPoints).Cast<Point3d>().Select(PrimitiveAccess.JsonPoint).ToArray()),
                ["bulges"] = new JsonArray(Enumerable.Range(0, Math.Max(0, line.PIPointsCount - 1)).Select(i => JsonValue.Create(line.GetBulge(i))).ToArray()) };
            if (!new[] { "elevations", "insertPI", "deletePI", "insertElevation", "deleteElevation", "surface", "newName", "description", "layer", "style" }.Any(k => r[k] is not null))
                throw new ArgumentException("수정할 형상선 속성을 지정하세요.");
            details.Add($"형상선 {line.Name} [{line.Handle}] 수정. 연결된 지표면·정지·코리더에 영향을 줄 수 있습니다.");
        }
        if (r["newName"] is not null)
        {
            string newName = CivilObjectAccess.Text(r, "newName");
            SymbolUtilityServices.ValidateSymbolName(newName, false);
            if (PrimitiveAccess.Entities(db, tr, true).OfType<FeatureLine>().Any(e => e.ObjectId != line!.ObjectId && e.Name.Equals(newName, StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("형상선 이름이 이미 있습니다.");
        }
        if (create || r["layer"] is not null) PrimitiveAccess.Layer(db, tr, r);
        if (r["style"] is not null) CivilObjectAccess.Style(tr, db, "featureLine", r["style"]!.GetValue<string>());
        if (r["surface"] is not null)
        {
            TinSurface surface = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface"));
            r["surface"] = surface.Handle.ToString();
            details.Add($"지표면 {surface.Name}에서 표고 적용 (중간점 추가: {r["insertIntermediate"]?.ToString() ?? "false"})");
        }
        if (r["elevations"] is JsonArray elevations)
        {
            if (create || r["surface"] is not null || new[] { "insertPI", "deletePI", "insertElevation", "deleteElevation" }.Any(k => r[k] is not null))
                throw new ArgumentException("인덱스 표고 변경은 생성·지표면 적용·점 추가/삭제와 별도 계획으로 수행하세요.");
            if (elevations.Count is < 1 or > 1000) throw new ArgumentException("표고 편집은 1~1000개입니다.");
            foreach (JsonNode? e in elevations)
            {
                int index = e?["index"]?.GetValue<int>() ?? -1;
                if (index < 0 || index >= line!.PointsCount) throw new ArgumentException("형상선 점 인덱스 범위를 벗어났습니다.");
                CivilObjectAccess.Number(e?["elevation"]);
            }
        }
        foreach (string key in new[] { "insertPI", "deletePI", "insertElevation", "deleteElevation" })
            if (r[key] is not null) GeometryExtensions.Points(r, key, 1);
        details.AddRange(CivilPlanDetails.Describe(r));
        return create ? $"형상선 {r["name"]} 생성" : $"형상선 {line!.Name} 수정";
    }

    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        bool create = CivilObjectAccess.Text(r, "operation") == "featureLine.create";
        ObjectId id;
        if (create)
        {
            var source = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source"));
            // Build from an owned clone, so Civil conversion cannot consume the caller's original.
            IdMapping mapping = new();
            db.DeepCloneObjects(new ObjectIdCollection(new[] { source.ObjectId }), source.OwnerId, mapping, false);
            ObjectId copyId = mapping[source.ObjectId].Value;
            id = FeatureLine.Create(CivilObjectAccess.Text(r, "name"), copyId);
            if (!copyId.IsErased) tr.GetObject(copyId, OpenMode.ForWrite).Erase();
        }
        else id = Find<FeatureLine>(db, tr, CivilObjectAccess.Text(r, "featureLine")).ObjectId;
        FeatureLine line = (FeatureLine)tr.GetObject(id, OpenMode.ForWrite);
        if (r["newName"] is not null) line.Name = CivilObjectAccess.Text(r, "newName");
        if (r["description"] is not null) line.Description = CivilObjectAccess.Text(r, "description");
        if (r["layer"] is not null) line.LayerId = PrimitiveAccess.Layer(db, tr, r);
        if (r["style"] is not null) line.StyleId = CivilObjectAccess.Style(tr, db, "featureLine", CivilObjectAccess.Text(r, "style"));
        foreach (string key in new[] { "deleteElevation", "deletePI", "insertPI", "insertElevation" })
            if (r[key] is not null) foreach (Point3d p in GeometryExtensions.Points(r, key, 1))
                switch (key)
                {
                    case "deleteElevation": line.DeleteElevationPoint(p); break;
                    case "deletePI": line.DeletePIPoint(p); break;
                    case "insertPI": line.InsertPIPoint(p); break;
                    case "insertElevation": line.InsertElevationPoint(p); break;
                }
        if (r["surface"] is not null) line.AssignElevationsFromSurface(
            CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface")).ObjectId,
            r["insertIntermediate"]?.GetValue<bool>() ?? false);
        if (r["elevations"] is JsonArray elevations)
            foreach (JsonNode? e in elevations) line.SetPointElevation(e!["index"]!.GetValue<int>(), CivilObjectAccess.Number(e["elevation"]));
        return new { name = line.Name, handle = line.Handle.ToString(), points = line.PointsCount };
    }
}
