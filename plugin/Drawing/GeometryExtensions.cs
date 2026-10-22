using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

// Explicit coordinates and distances only; never drive the command line with user-supplied strings.
internal static class GeometryExtensions
{
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string action = CivilObjectAccess.Text(r, "action");
        if (action == "polyline3d")
        {
            Points(r, "points", 2);
            PrimitiveAccess.Layer(db, tr, r);
            details.AddRange(CivilPlanDetails.Describe(r));
            return "3D 폴리선 생성";
        }
        Entity[] entities = PrimitiveAccess.Targets<Curve>(db, tr, r);
        if (entities.Any(e => e is not (Line or Polyline or Circle or Arc)))
            throw new ArgumentException("일반 선·폴리선·원·호만 지원합니다.");
        r["sourceState"] = new JsonArray(entities.Select(GeometryEditing.Snapshot).ToArray());
        if (action is "vertices" or "trim" or "break" or "extend" && entities.Length != 1)
            throw new ArgumentException("이 작업은 도형 하나씩 지정하세요.");
        // Calculate on detached clones as validation; no database objects are changed.
        foreach (Entity entity in entities)
        {
            using Entity clone = (Entity)entity.Clone();
            using DBObjectCollection result = Calculate((Curve)clone, r);
            foreach (DBObject item in result) item.Dispose();
            details.Add($"{action}: {entity.GetType().Name} [{entity.Handle}], 레이어 {entity.Layer}");
        }
        details.Add("좌표는 WCS, 길이는 도면 단위입니다. trim/break는 원본을 구간 객체로 교체합니다.");
        details.AddRange(CivilPlanDetails.Describe(r));
        return $"일반 도형 {entities.Length}개 {CivilPlanDetails.Action(action)}";
    }

    internal static Point3d[] Points(JsonObject r, string key, int min)
    {
        JsonArray a = r[key] as JsonArray ?? throw new ArgumentException($"{key} 좌표가 필요합니다.");
        if (a.Count < min || a.Count > 1000) throw new ArgumentException($"좌표는 {min}~1000개입니다.");
        return a.Select(PrimitiveAccess.Point).ToArray();
    }

    private static DBObjectCollection Calculate(Curve source, JsonObject r)
    {
        string action = CivilObjectAccess.Text(r, "action");
        DBObjectCollection result = new();
        switch (action)
        {
            case "copy":
                source.TransformBy(Matrix3d.Displacement(PrimitiveAccess.Point(r["moveBy"]) - Point3d.Origin));
                break;
            case "mirror":
                Point3d a = PrimitiveAccess.Point(r["axisStart"]), b = PrimitiveAccess.Point(r["axisEnd"]);
                if (a.DistanceTo(b) < 1e-9) throw new ArgumentException("대칭축의 두 점이 같을 수 없습니다.");
                if (Math.Abs(a.Z - b.Z) > 1e-9) throw new ArgumentException("대칭축은 같은 WCS 표고에 지정하세요.");
                source.TransformBy(Matrix3d.Mirroring(new Plane(a, b - a, Vector3d.ZAxis)));
                break;
            case "offset":
                double distance = CivilObjectAccess.Number(r["distance"]);
                if (Math.Abs(distance) < 1e-9) throw new ArgumentException("오프셋 거리는 0일 수 없습니다.");
                result.Dispose();
                return source.GetOffsetCurves(distance);
            case "array":
                int count = r["count"]?.GetValue<int>() ?? 0;
                if (count < 2 || count > 100) throw new ArgumentException("배열 총 개수는 원본 포함 2~100개입니다.");
                Vector3d step = PrimitiveAccess.Point(r["moveBy"]) - Point3d.Origin;
                if (step.Length < 1e-9) throw new ArgumentException("배열 간격은 0일 수 없습니다.");
                for (int i = 1; i < count; i++)
                {
                    Entity copy = (Entity)source.Clone();
                    copy.TransformBy(Matrix3d.Displacement(step * i));
                    result.Add(copy);
                }
                return result;
            case "vertices":
                if (source is not Polyline p || (p.Normal - Vector3d.ZAxis).Length > 1e-9)
                    throw new ArgumentException("WCS XY 평면의 2D 폴리선만 정점을 편집합니다.");
                Point3d[] points = Points(r, "points", 2);
                if (points.Any(pt => Math.Abs(pt.Z - points[0].Z) > 1e-9))
                    throw new ArgumentException("2D 폴리선 정점은 같은 표고여야 합니다.");
                while (p.NumberOfVertices > 0) p.RemoveVertexAt(p.NumberOfVertices - 1);
                for (int i = 0; i < points.Length; i++)
                {
                    double bulge = r["bulges"] is JsonArray bulges && i < bulges.Count
                        ? CivilObjectAccess.Number(bulges[i]) : 0;
                    p.AddVertexAt(i, new Point2d(points[i].X, points[i].Y), bulge, 0, 0);
                }
                p.Elevation = points[0].Z;
                p.Closed = r["closed"]?.GetValue<bool>() ?? p.Closed;
                break;
            case "extend":
                if (source is not (Line or Arc)) throw new ArgumentException("선·호만 연장합니다.");
                source.Extend(r["atStart"]?.GetValue<bool>() ?? false, PrimitiveAccess.Point(r["point"]));
                break;
            case "trim":
            case "break":
                if (source.Closed) throw new ArgumentException("열린 곡선만 구간을 자르거나 끊습니다.");
                double length = source.GetDistanceAtParameter(source.EndParam);
                double from = CivilObjectAccess.Number(r["fromDistance"]), to = CivilObjectAccess.Number(r["toDistance"]);
                if (from < 0 || to > length || to - from < 1e-9)
                    throw new ArgumentException("0 ≤ 시작거리 < 끝거리 ≤ 곡선 길이로 지정하세요.");
                if (action == "break" && from == 0 && to == length)
                    throw new ArgumentException("끊기로 곡선 전체를 삭제할 수 없습니다.");
                DoubleCollection parameters = new();
                if (from > 0) parameters.Add(source.GetParameterAtDistance(from));
                if (to < length) parameters.Add(source.GetParameterAtDistance(to));
                if (parameters.Count == 0) throw new ArgumentException("변경되는 구간이 없습니다.");
                using (DBObjectCollection segments = source.GetSplitCurves(parameters))
                {
                    int index = 0;
                    int middle = from > 0 ? 1 : 0;
                    foreach (DBObject segment in segments)
                    {
                        bool keep = action == "trim" ? index == middle : index != middle;
                        if (keep) result.Add(segment); else segment.Dispose();
                        index++;
                    }
                }
                return result;
            default: throw new ArgumentException("지원하지 않는 도형 작업입니다.");
        }
        result.Add((Entity)source.Clone());
        return result;
    }

    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string action = CivilObjectAccess.Text(r, "action");
        List<string> created = new(), edited = new();
        if (action == "polyline3d")
        {
            using Polyline3d p = new(Poly3dType.SimplePoly, new Point3dCollection(Points(r, "points", 2)),
                r["closed"]?.GetValue<bool>() ?? false);
            p.LayerId = PrimitiveAccess.Layer(db, tr, r);
            PrimitiveAccess.Append(db, tr, p);
            return new { created = new[] { p.Handle.ToString() } };
        }
        foreach (JsonNode? node in (JsonArray)r["handles"]!)
        {
            Curve source = (Curve)CivilObjectAccess.ByHandle(tr, db, node!.GetValue<string>());
            using Curve clone = (Curve)source.Clone();
            using DBObjectCollection results = Calculate(clone, r);
            bool inPlace = action is "vertices" or "extend" || action == "mirror" && r["eraseSource"]?.GetValue<bool>() == true;
            if (inPlace)
            {
                source.UpgradeOpen();
                if (action == "vertices")
                {
                    Polyline p = (Polyline)source, value = (Polyline)results[0];
                    while (p.NumberOfVertices > 0) p.RemoveVertexAt(p.NumberOfVertices - 1);
                    for (int i = 0; i < value.NumberOfVertices; i++)
                        p.AddVertexAt(i, value.GetPoint2dAt(i), value.GetBulgeAt(i), 0, 0);
                    p.Elevation = value.Elevation; p.Closed = value.Closed;
                }
                else if (action == "extend") source.Extend(r["atStart"]?.GetValue<bool>() ?? false, PrimitiveAccess.Point(r["point"]));
                else
                {
                    Point3d a = PrimitiveAccess.Point(r["axisStart"]), b = PrimitiveAccess.Point(r["axisEnd"]);
                    source.TransformBy(Matrix3d.Mirroring(new Plane(a, b - a, Vector3d.ZAxis)));
                }
                edited.Add(source.Handle.ToString());
                foreach (DBObject item in results) item.Dispose();
                continue;
            }
            BlockTableRecord owner = (BlockTableRecord)tr.GetObject(source.OwnerId, OpenMode.ForWrite);
            foreach (Entity entity in results)
            {
                entity.SetPropertiesFrom(source);
                owner.AppendEntity(entity); tr.AddNewlyCreatedDBObject(entity, true);
                created.Add(entity.Handle.ToString());
            }
            if (action is "trim" or "break") { source.UpgradeOpen(); source.Erase(); }
        }
        return new { created, edited };
    }
}
