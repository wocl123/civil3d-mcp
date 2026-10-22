using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;
using NativeAlignmentCurve = Autodesk.Civil.DatabaseServices.AlignmentCurve;

namespace MyCivil3DMcp.Plugin;

internal static class AlignmentGeometryChanges
{
    private static NativeAlignmentCurve[] Curves(Alignment a) => a.Entities.Cast<AlignmentEntity>().OfType<NativeAlignmentCurve>().OrderBy(e => e.StartStation).ToArray();
    private static Point3d Point(JsonNode? n)
    {
        Point3d p = PrimitiveAccess.Point(n); if (Math.Abs(p.Z) > 1e-9) throw new ArgumentException("평면 선형은 XY(z=0)로 지정하세요."); return p;
    }
    private static double NeededEnd(Database db, Transaction tr, Alignment a)
    {
        double end = a.StartingStation;
        foreach (ObjectId id in a.GetProfileIds()) { var p = (Profile)tr.GetObject(id, OpenMode.ForRead); CorridorEditing.Guard(db, tr, p); end = Math.Max(end, p.EndingStation); }
        foreach (ObjectId id in a.GetProfileViewIds()) CorridorEditing.Guard(db, tr, (ProfileView)tr.GetObject(id, OpenMode.ForRead));
        foreach (var group in SectionChanges.Groups(db, tr).Where(g => g.ParentAlignmentId == a.ObjectId))
        {
            CorridorEditing.Guard(db, tr, group);
            foreach (ObjectId id in group.GetSampleLineIds())
            {
                var line = (SampleLine)tr.GetObject(id, OpenMode.ForRead); CorridorEditing.Guard(db, tr, line); end = Math.Max(end, line.Station);
                foreach (ObjectId view in line.GetSectionViewIds()) CorridorEditing.Guard(db, tr, (SectionView)tr.GetObject(view, OpenMode.ForRead));
            }
        }
        foreach (Corridor c in CorridorChanges.Objects<Corridor>(db, tr)) foreach (Baseline b in c.Baselines.Where(b => !b.IsFeatureLineBased() && b.AlignmentId == a.ObjectId))
        { CorridorEditing.Guard(db, tr, c); end = Math.Max(end, b.EndStation); }
        return end;
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        var a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment")); CorridorEditing.Guard(db, tr, a);
        if (a.IsConnectedAlignment || a.IsOffsetAlignment || a.StationEquations.Count > 0) throw new ArgumentException("연결·오프셋·측점 방정식 선형은 이 요소 편집 도구에서 지원하지 않습니다.");
        r["alignment"] = a.Handle.ToString(); r["sourceState"] = a.ComputeFingerPrint().ToString("X");
        NativeAlignmentCurve[] curves = Curves(a);
        if (curves.Length == 0 || curves.Length != a.Entities.Count) throw new ArgumentException("지원하지 않는 복합 선형 요소가 있습니다.");
        double needed = NeededEnd(db, tr, a); r["neededEnd"] = needed;
        string action = CivilObjectAccess.Text(r, "action"); NativeAlignmentCurve last = curves[^1];
        if (action == "movePI")
        {
            if (curves.Any(c => c is not AlignmentLine)) throw new ArgumentException("PI 이동은 현재 고정 직선만으로 된 연속 선형에서 지원합니다. 곡선 포함 선형은 기본 편집기를 사용하세요.");
            int index = r["index"]!.GetValue<int>(); if (index < 0 || index > curves.Length) throw new ArgumentException("PI 인덱스 범위를 확인하세요.");
            for (int i = 1; i < curves.Length; i++) if (curves[i - 1].EndPoint.GetDistanceTo(curves[i].StartPoint) > 1e-6) throw new ArgumentException("연속되지 않은 직선 선형입니다.");
            Point3d p = Point(r["point"]); Point2d xy = new(p.X, p.Y);
            var vertices = curves.Select(c => c.StartPoint).Append(last.EndPoint).ToArray(); vertices[index] = xy;
            double length = 0;
            for (int i = 1; i < vertices.Length; i++) { double d = vertices[i - 1].GetDistanceTo(vertices[i]); if (d <= 1e-6) throw new ArgumentException("길이가 0인 요소가 생깁니다."); length += d; }
            if (a.StartingStation + length < needed - 1e-6) throw new ArgumentException("기존 종단·횡단·코리더의 측점 범위가 새 선형을 벗어납니다.");
        }
        else if (action == "appendLine")
        {
            var p = Point(r["point"]); if (last.EndPoint.GetDistanceTo(new Point2d(p.X, p.Y)) <= 1e-6) throw new ArgumentException("연장 끝점이 현재 끝점과 같습니다.");
        }
        else if (action == "appendArc")
        {
            var mid = Point(r["midPoint"]); var end = Point(r["point"]);
            var start = new Point3d(last.EndPoint.X, last.EndPoint.Y, 0);
            if ((mid - start).CrossProduct(end - start).Length <= 1e-9) throw new ArgumentException("원곡선의 세 점이 일직선이거나 겹칩니다.");
        }
        else if (action == "appendSpiral")
        {
            double start = CivilObjectAccess.Number(r["startRadius"]), end = CivilObjectAccess.Number(r["endRadius"]), length = CivilObjectAccess.Number(r["length"]);
            if (start < 0 || end < 0 || start == end || length <= 0) throw new ArgumentException("서로 다른 비음수 시작/끝 반지름과 양의 완화곡선 길이를 지정하세요. API의 0 반지름은 무한대를 뜻합니다.");
            if (!Enum.TryParse<SpiralType>(r["spiralType"]?.ToString() ?? "Clothoid", out var type) || !Enum.IsDefined(type)) throw new ArgumentException("지원하지 않는 완화곡선 종류입니다.");
        }
        else if (action == "removeLast")
        {
            if (curves.Length < 2 || last.StartStation < needed - 1e-6) throw new ArgumentException("마지막 요소가 기존 종단·횡단·코리더 범위에 필요하거나 유일한 요소입니다.");
        }
        else if (action == "arcRadius")
        {
            if (a.Entities.EntityAtId(r["entityId"]!.GetValue<int>()) is not AlignmentArc || CivilObjectAccess.Number(r["radius"]) <= 0) throw new ArgumentException("원곡선 요소 ID와 양의 반지름이 필요합니다.");
        }
        else throw new ArgumentException("지원하지 않는 선형 요소 편집입니다.");
        details.Add("기존 선형 핸들을 유지하고 요소를 편집합니다. 연결된 종단·횡단·코리더는 재검토가 필요하며 모든 설계 기준 충족을 보증하지 않습니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return "선형 PI·요소 편집";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment")); a.UpgradeOpen();
        NativeAlignmentCurve[] curves = Curves(a); var last = curves[^1]; string action = CivilObjectAccess.Text(r, "action");
        Point3d End() => Point(r["point"]);
        if (action == "movePI")
        {
            int i = r["index"]!.GetValue<int>(); var p = End(); Point2d xy = new(p.X, p.Y);
            if (i > 0) ((AlignmentLine)curves[i - 1]).PassThroughPoint2 = xy;
            if (i < curves.Length) ((AlignmentLine)curves[i]).PassThroughPoint1 = xy;
        }
        else if (action == "appendLine") a.Entities.AddFixedLine(last.EntityId, new Point3d(last.EndPoint.X, last.EndPoint.Y, 0), End());
        else if (action == "appendArc") a.Entities.AddFixedCurve(last.EntityId, new Point3d(last.EndPoint.X, last.EndPoint.Y, 0), Point(r["midPoint"]), End());
        else if (action == "appendSpiral") a.Entities.AddFixedSpiral(last.EntityId, CivilObjectAccess.Number(r["startRadius"]), CivilObjectAccess.Number(r["endRadius"]), CivilObjectAccess.Number(r["length"]), Enum.Parse<SpiralType>(r["spiralType"]?.ToString() ?? "Clothoid"));
        else if (action == "removeLast") a.Entities.Remove(last);
        else ((AlignmentArc)a.Entities.EntityAtId(r["entityId"]!.GetValue<int>())).Radius = CivilObjectAccess.Number(r["radius"]);
        if (a.EndingStation < CivilObjectAccess.Number(r["neededEnd"]) - 1e-6) throw new ArgumentException("편집 후 선형이 기존 설계의 측점 범위를 벗어납니다. 변경을 취소합니다.");
        return new { handle = a.Handle.ToString(), entities = a.Entities.Count, length = a.Length };
    }
}
