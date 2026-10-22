using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class CatchmentChanges
{
    private static Point3d[] Boundary(JsonObject r)
    {
        Point3d[] points = GeometryExtensions.Points(r, "points", 3);
        if (points[^1].IsEqualTo(points[0])) points = points[..^1];
        if (points.Length < 3 || points.Length > 1000 || points.Any(p => p.Z != 0) || points.Distinct().Count() != points.Length)
            throw new ArgumentException("경계는 중복 없는 XY(z=0) 꼭짓점 3~1000개입니다.");
        double Cross(Point3d a, Point3d b, Point3d c) => (b.X - a.X) * (c.Y - a.Y) - (b.Y - a.Y) * (c.X - a.X);
        bool On(Point3d a, Point3d b, Point3d p) => Math.Abs(Cross(a, b, p)) < 1e-9
            && p.X >= Math.Min(a.X, b.X) - 1e-9 && p.X <= Math.Max(a.X, b.X) + 1e-9
            && p.Y >= Math.Min(a.Y, b.Y) - 1e-9 && p.Y <= Math.Max(a.Y, b.Y) + 1e-9;
        for (int i = 0; i < points.Length; i++)
            for (int j = i + 1; j < points.Length; j++)
            {
                int nextI = (i + 1) % points.Length, nextJ = (j + 1) % points.Length;
                if (nextI == j || nextJ == i) continue;
                Point3d a = points[i], b = points[nextI], c = points[j], d = points[nextJ];
                if ((Cross(a, b, c) * Cross(a, b, d) < 0 && Cross(c, d, a) * Cross(c, d, b) < 0)
                    || On(a, b, c) || On(a, b, d) || On(c, d, a) || On(c, d, b)) throw new ArgumentException("집수구역 경계가 교차하거나 겹칩니다.");
            }
        return points.Append(points[0]).ToArray();
    }
    private static IEnumerable<CatchmentGroup> Groups(Database db, Transaction tr) => CatchmentGroupCollection.GetCatchmentGroups(db)
        .Cast<ObjectId>().Select(id => (CatchmentGroup)tr.GetObject(id, OpenMode.ForRead));
    private static CatchmentGroup Group(Database db, Transaction tr, string handle)
    {
        if (!long.TryParse(handle, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long value)
            || !db.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased || tr.GetObject(id, OpenMode.ForRead) is not CatchmentGroup group)
            throw new ArgumentException("집수구역 그룹의 정확한 핸들을 지정하세요.");
        return group;
    }
    private static JsonObject State(Catchment c) => new() { ["name"] = c.Name, ["handle"] = c.Handle.ToString(),
        ["fingerprint"] = c.ComputeFingerPrint().ToString("X"), ["group"] = c.ContainingGroupId.Handle.ToString(),
        ["runoffCoefficient"] = c.RunoffCoefficient, ["curveNumber"] = c.CurveNumber,
        ["boundary"] = new JsonArray(c.BoundaryPolyline3d.Cast<Point3d>().Select(p => (JsonNode)PrimitiveAccess.JsonPoint(p)).ToArray()) };
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        if (r["group"] is not null)
        {
            ObjectId[] ids = Group(doc.Database, tr, CivilObjectAccess.Text(r, "group")).GetAllCatchmentIds().Cast<ObjectId>().ToArray();
            return new { total = ids.Length, offset, items = ids.Skip(offset).Take(limit).Select(id => State((Catchment)tr.GetObject(id, OpenMode.ForRead))).ToArray(), hasMore = offset + limit < ids.Length };
        }
        object[] all = Groups(doc.Database, tr).Select(g => (object)new { handle = g.Handle.ToString(), count = g.GetAllCatchmentIds().Count }).ToArray();
        return new { total = all.Length, offset, items = all.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < all.Length };
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "catchmentGroup.create")
        {
            SymbolUtilityServices.ValidateSymbolName(CivilObjectAccess.Text(r, "name"), false);
            r["groupsState"] = new JsonArray(Groups(db, tr).Select(g => JsonValue.Create(g.Handle.ToString())).ToArray());
            details.Add("집수구역 그룹 생성. 중복 이름은 Civil 3D 생성 시 거부합니다.");
        }
        else if (op == "catchment.create")
        {
            var group = Group(db, tr, CivilObjectAccess.Text(r, "group"));
            if (group.GetAllCatchmentIds().Cast<ObjectId>().Any(id => ((Catchment)tr.GetObject(id, OpenMode.ForRead)).Name.Equals(CivilObjectAccess.Text(r, "name"), StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("집수구역 이름이 중복됩니다.");
            r["groupState"] = new JsonArray(group.GetAllCatchmentIds().Cast<ObjectId>().Select(id => JsonValue.Create(id.Handle.ToString())).ToArray());
            var surface = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface"));
            r["surface"] = surface.Handle.ToString(); r["surfaceState"] = surface.ComputeFingerPrint().ToString("X");
            CivilObjectAccess.Style(tr, db, "catchment", r["style"]?.ToString()); PrimitiveAccess.Layer(db, tr, r);
            Point3d[] points = Boundary(r);
            double area = 0;
            for (int i = 0; i < points.Length; i++) { Point3d a = points[i], b = points[(i + 1) % points.Length]; area += a.X * b.Y - b.X * a.Y; }
            if (Math.Abs(area) < 1e-9) throw new ArgumentException("집수구역 경계 면적이 0입니다.");
            details.Add("명시한 경계와 지표면으로 집수구역 생성. 유량 해석이나 배수 설계 완료를 의미하지 않습니다.");
        }
        else
        {
            var c = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")) as Catchment ?? throw new ArgumentException("집수구역 핸들을 지정하세요.");
            CorridorEditing.Guard(db, tr, c); r["sourceState"] = State(c);
            if (!new[] { "newName", "runoffCoefficient", "curveNumber", "group" }.Any(k => r[k] is not null)) throw new ArgumentException("변경할 집수구역 속성을 지정하세요.");
            var group = r["group"] is null ? (CatchmentGroup)tr.GetObject(c.ContainingGroupId, OpenMode.ForRead) : Group(db, tr, CivilObjectAccess.Text(r, "group"));
            string name = r["newName"]?.ToString() ?? c.Name;
            if (group.GetAllCatchmentIds().Cast<ObjectId>().Any(id => id != c.ObjectId && ((Catchment)tr.GetObject(id, OpenMode.ForRead)).Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("대상 그룹에 같은 집수구역 이름이 있습니다.");
            if (r["dischargePoint"] is not null) throw new ArgumentException("유출점은 직접 쓰기 API가 없습니다. 기본 집수구역 편집을 사용하세요.");
        }
        if (r["runoffCoefficient"] is not null && (CivilObjectAccess.Number(r["runoffCoefficient"]) < 0 || CivilObjectAccess.Number(r["runoffCoefficient"]) > 1)) throw new ArgumentException("유출계수는 0~1입니다.");
        if (r["curveNumber"] is not null && (r["curveNumber"]!.GetValue<int>() < 1 || r["curveNumber"]!.GetValue<int>() > 100)) throw new ArgumentException("Curve Number는 1~100입니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return CivilPlanDetails.Title(op);
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "catchmentGroup.create") return new { handle = CatchmentGroup.Create(db, CivilObjectAccess.Text(r, "name")).Handle.ToString() };
        Catchment c;
        if (op == "catchment.create")
        {
            CatchmentGroup group = Group(db, tr, CivilObjectAccess.Text(r, "group")); group.UpgradeOpen();
            ObjectId id = Catchment.Create(CivilObjectAccess.Text(r, "name"), CivilObjectAccess.Style(tr, db, "catchment", r["style"]?.ToString()), group.ObjectId,
                CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface")).ObjectId, new Point3dCollection(Boundary(r)));
            c = (Catchment)tr.GetObject(id, OpenMode.ForWrite); c.LayerId = PrimitiveAccess.Layer(db, tr, r);
        }
        else { c = (Catchment)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")); c.UpgradeOpen(); }
        if (r["group"] is not null && op == "catchment.edit") CatchmentGroup.MoveCatchment(c.ObjectId, Group(db, tr, CivilObjectAccess.Text(r, "group")).ObjectId);
        if (r["newName"] is not null) c.Name = CivilObjectAccess.Text(r, "newName");
        if (r["runoffCoefficient"] is not null) c.RunoffCoefficient = CivilObjectAccess.Number(r["runoffCoefficient"]);
        if (r["curveNumber"] is not null) c.CurveNumber = r["curveNumber"]!.GetValue<int>();
        return new { handle = c.Handle.ToString(), state = State(c) };
    }
}
