using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.DatabaseServices;
using CivilEntity = Autodesk.Civil.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

internal static class EngineeringLabelChanges
{
    private static CivilEntity Source(Database db, Transaction tr, JsonObject r) => CivilObjectAccess.Text(r, "kind") switch {
        "stationOffset" => CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "source")),
        "stationElevation" => CivilObjectAccess.Find<ProfileView>(tr, db, CivilObjectAccess.Text(r, "source")),
        _ => CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source")) as CivilEntity ?? throw new ArgumentException("Civil 원본 핸들을 지정하세요.") };
    private static string StyleKind(string kind) => kind switch { "stationOffset" => "stationOffsetLabel", "stationElevation" => "stationElevationLabel",
        "offsetElevation" => "offsetElevationLabel", "pipe" => "pipeLabel", "structure" => "structureLabel", _ => throw new ArgumentException("지원하지 않는 Civil 라벨 종류입니다.") };
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string kind = CivilObjectAccess.Text(r, "kind"); var source = Source(db, tr, r); CorridorEditing.Guard(db, tr, source);
        r["source"] = source.Handle.ToString(); r["sourceState"] = source.ComputeFingerPrint().ToString("X");
        CivilObjectAccess.Style(tr, db, StyleKind(kind), CivilObjectAccess.Text(r, "style")); PrimitiveAccess.Layer(db, tr, r);
        if (kind is "stationOffset" or "structure") PrimitiveAccess.Point(r["position"]);
        if (kind == "stationOffset")
        {
            var p = PrimitiveAccess.Point(r["position"]); double station = 0, offset = 0; ((Alignment)source).StationOffset(p.X, p.Y, ref station, ref offset);
        }
        else if (kind == "stationElevation")
        {
            if (source is not ProfileView v) throw new ArgumentException("종단뷰를 지정하세요.");
            double s = CivilObjectAccess.Number(r["station"]), e = CivilObjectAccess.Number(r["elevation"]);
            if (s < v.StationStart || s > v.StationEnd || e < v.ElevationMin || e > v.ElevationMax) throw new ArgumentException("측점·표고는 종단뷰 범위 안으로 지정하세요.");
        }
        else if (kind == "offsetElevation")
        {
            if (source is not SectionView v) throw new ArgumentException("횡단뷰를 지정하세요.");
            double o = CivilObjectAccess.Number(r["offset"]), e = CivilObjectAccess.Number(r["elevation"]);
            if (o < v.OffsetLeft || o > v.OffsetRight || e < v.ElevationMin || e > v.ElevationMax) throw new ArgumentException("옵셋·표고는 횡단뷰 범위 안으로 지정하세요.");
        }
        else if (kind == "pipe")
        {
            if (source is not Pipe || CivilObjectAccess.Number(r["ratio"]) < 0 || CivilObjectAccess.Number(r["ratio"]) > 1) throw new ArgumentException("중력관과 구간 비율 0~1을 지정하세요.");
        }
        else if (kind == "structure" && source is not Structure) throw new ArgumentException("중력식 관망 구조물을 지정하세요.");
        if (kind is "stationOffset" or "stationElevation" or "offsetElevation") CivilObjectAccess.Style(tr, db, "marker", r["markerStyle"]?.ToString());
        details.Add("원본 Civil 객체에 연결되는 실제 라벨을 생성합니다. 문자 덮어쓰기로 수치를 조작하지 않습니다."); details.AddRange(CivilPlanDetails.Describe(r));
        return "선형·종횡단뷰·관망 Civil 라벨 생성";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string kind = CivilObjectAccess.Text(r, "kind"); var source = Source(db, tr, r); source.UpgradeOpen();
        ObjectId style = CivilObjectAccess.Style(tr, db, StyleKind(kind), CivilObjectAccess.Text(r, "style"));
        ObjectId Marker() => CivilObjectAccess.Style(tr, db, "marker", r["markerStyle"]?.ToString());
        ObjectId id;
        if (kind == "stationOffset") { Point3d p = PrimitiveAccess.Point(r["position"]); id = StationOffsetLabel.Create(source.ObjectId, style, Marker(), new Point2d(p.X, p.Y)); }
        else if (kind == "stationElevation") id = StationElevationLabel.Create(source.ObjectId, style, Marker(), CivilObjectAccess.Number(r["station"]), CivilObjectAccess.Number(r["elevation"]));
        else if (kind == "offsetElevation") id = SectionViewOffsetElevationLabel.Create(source.ObjectId, CivilObjectAccess.Number(r["offset"]), CivilObjectAccess.Number(r["elevation"]), style, Marker());
        else if (kind == "pipe") id = PipeLabel.Create(source.ObjectId, CivilObjectAccess.Number(r["ratio"]), style);
        else id = StructureLabel.Create(source.ObjectId, style, PrimitiveAccess.Point(r["position"]));
        ((Label)tr.GetObject(id, OpenMode.ForWrite)).LayerId = PrimitiveAccess.Layer(db, tr, r);
        return new { handle = id.Handle.ToString(), kind };
    }
}
