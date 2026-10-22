using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

internal static class GeometryCorners
{
    private static Line[] Lines(Database db, Transaction tr, JsonObject r) => PrimitiveAccess.Targets<Line>(db, tr, r).Cast<Line>().ToArray();
    private static (Point3d Corner, Point3d A, Point3d B, bool EndA, bool EndB) Corner(Line[] lines)
    {
        if (lines.Length != 2) throw new ArgumentException("끝점이 만나는 일반 선 2개를 지정하세요.");
        var candidates = new[] { (lines[0].StartPoint, lines[0].EndPoint, false), (lines[0].EndPoint, lines[0].StartPoint, true) };
        foreach (var (p, far, endA) in candidates)
        {
            if (p.DistanceTo(lines[1].StartPoint) < 1e-8) return (p, far, lines[1].EndPoint, endA, false);
            if (p.DistanceTo(lines[1].EndPoint) < 1e-8) return (p, far, lines[1].StartPoint, endA, true);
        }
        throw new ArgumentException("두 선의 끝점이 같은 모서리에서 만나야 합니다.");
    }
    private static Point3d[] Chain(Line[] lines)
    {
        foreach (bool reverse in new[] { false, true })
        {
            List<Point3d> points = new() { reverse ? lines[0].EndPoint : lines[0].StartPoint, reverse ? lines[0].StartPoint : lines[0].EndPoint };
            bool good = true;
            foreach (Line l in lines.Skip(1))
            {
                if (l.StartPoint.DistanceTo(points[^1]) < 1e-8) points.Add(l.EndPoint);
                else if (l.EndPoint.DistanceTo(points[^1]) < 1e-8) points.Add(l.StartPoint);
                else { good = false; break; }
            }
            if (good) return points.ToArray();
        }
        throw new ArgumentException("결합할 선을 연결된 순서대로 지정하세요. 끝점이 일치해야 합니다.");
    }
    private static (Point3d A, Point3d B, Point3d Center) Calculate(Line[] lines, JsonObject r)
    {
        var c = Corner(lines);
        Vector3d u = c.A - c.Corner, v = c.B - c.Corner;
        if (Math.Abs(u.Z) > 1e-8 || Math.Abs(v.Z) > 1e-8 || u.Length < 1e-8 || v.Length < 1e-8)
            throw new ArgumentException("같은 WCS XY 평면의 길이 있는 선만 모서리를 편집합니다.");
        double angle = u.GetAngleTo(v);
        if (angle < 1e-6 || Math.PI - angle < 1e-6) throw new ArgumentException("평행·일직선 모서리는 편집할 수 없습니다.");
        Vector3d un = u.GetNormal(), vn = v.GetNormal();
        bool fillet = CivilObjectAccess.Text(r, "action") == "fillet";
        double radius = fillet ? CivilObjectAccess.Number(r["radius"]) : 0;
        double a = fillet ? radius / Math.Tan(angle / 2) : CivilObjectAccess.Number(r["distanceA"]);
        double b = fillet ? a : CivilObjectAccess.Number(r["distanceB"]);
        if (a <= 0 || b <= 0 || a >= u.Length || b >= v.Length) throw new ArgumentException("반지름·모따기 거리가 선 길이를 초과하거나 0 이하입니다.");
        return (c.Corner + un * a, c.Corner + vn * b, fillet ? c.Corner + (un + vn).GetNormal() * (radius / Math.Sin(angle / 2)) : Point3d.Origin);
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        Line[] lines = Lines(db, tr, r);
        if (lines.Any(l => l.OwnerId != lines[0].OwnerId)) throw new ArgumentException("같은 공간의 도형만 편집합니다.");
        string action = CivilObjectAccess.Text(r, "action");
        if (action == "join")
        {
            if (lines.Length < 2 || lines.Length > 100) throw new ArgumentException("결합할 선 2~100개를 지정하세요.");
            Point3d[] pts = Chain(lines);
            if (pts.Any(p => Math.Abs(p.Z - pts[0].Z) > 1e-8)) throw new ArgumentException("결합할 선은 같은 표고여야 합니다.");
            if (lines.Any(l => l.LayerId != lines[0].LayerId || l.Color != lines[0].Color || l.LinetypeId != lines[0].LinetypeId || l.LineWeight != lines[0].LineWeight)) throw new ArgumentException("표시 속성이 같은 선만 결합합니다.");
            details.Add("순서대로 연결한 선들을 하나의 폴리선으로 교체합니다. 원래 선 핸들은 삭제됩니다.");
        }
        else if (action is "fillet" or "chamfer")
        {
            Calculate(lines, r); details.Add("공통 끝점에서 두 선을 줄이고 접선 호 또는 모따기 선을 추가합니다. 기존 두 선의 핸들은 유지합니다.");
        }
        else throw new ArgumentException("지원하지 않는 모서리 작업입니다.");
        r["sourceState"] = new JsonArray(lines.Select(GeometryEditing.Snapshot).ToArray());
        details.AddRange(CivilPlanDetails.Describe(r));
        return "도형 " + CivilPlanDetails.Action(action);
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        Line[] lines = Lines(db, tr, r);
        string action = CivilObjectAccess.Text(r, "action");
        BlockTableRecord owner = (BlockTableRecord)tr.GetObject(lines[0].OwnerId, OpenMode.ForWrite);
        if (lines.Any(l => l.OwnerId != owner.ObjectId)) throw new ArgumentException("같은 공간의 도형만 편집합니다.");
        Autodesk.AutoCAD.DatabaseServices.Entity created;
        if (action == "join")
        {
            Point3d[] pts = Chain(lines);
            Polyline p = new(); p.Elevation = pts[0].Z;
            for (int i = 0; i < pts.Length; i++) p.AddVertexAt(i, new Point2d(pts[i].X, pts[i].Y), 0, 0, 0);
            if (pts[0].DistanceTo(pts[^1]) < 1e-8) { p.RemoveVertexAt(p.NumberOfVertices - 1); p.Closed = true; }
            created = p;
        }
        else
        {
            var c = Corner(lines); var geometry = Calculate(lines, r);
            if (action == "fillet")
            {
                double start = Math.Atan2(geometry.A.Y - geometry.Center.Y, geometry.A.X - geometry.Center.X);
                double end = Math.Atan2(geometry.B.Y - geometry.Center.Y, geometry.B.X - geometry.Center.X);
                double sweep = (end - start + 2 * Math.PI) % (2 * Math.PI);
                if (sweep > Math.PI) (start, end) = (end, start);
                created = new Arc(geometry.Center, CivilObjectAccess.Number(r["radius"]), start, end);
            }
            else created = new Line(geometry.A, geometry.B);
            lines[0].UpgradeOpen(); lines[1].UpgradeOpen();
            if (c.EndA) lines[0].EndPoint = geometry.A; else lines[0].StartPoint = geometry.A;
            if (c.EndB) lines[1].EndPoint = geometry.B; else lines[1].StartPoint = geometry.B;
        }
        created.SetPropertiesFrom(lines[0]); owner.AppendEntity(created); tr.AddNewlyCreatedDBObject(created, true);
        if (action == "join") foreach (Line l in lines) { l.UpgradeOpen(); l.Erase(); }
        return new { created = new[] { created.Handle.ToString() } };
    }
}
