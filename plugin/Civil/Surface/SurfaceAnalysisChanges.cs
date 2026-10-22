using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class SurfaceAnalysisChanges
{
    private static JsonObject State(TinSurface s)
    {
        using var analysis = s.Analysis;
        return new JsonObject {
            ["elevations"] = new JsonArray(analysis.GetElevationData().Select(b => (JsonNode)new JsonObject { ["min"] = b.MinimumElevation, ["max"] = b.MaximumElevation, ["color"] = b.Scheme.ColorIndex }).ToArray()),
            ["slopes"] = new JsonArray(analysis.GetSlopeData().Select(b => (JsonNode)new JsonObject { ["min"] = b.MinimumSlope, ["max"] = b.MaximumSlope, ["color"] = b.Scheme.ColorIndex }).ToArray()) };
    }
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        var s = CivilObjectAccess.Find<TinSurface>(tr, doc.Database, CivilObjectAccess.Text(r, "surface"));
        return new { handle = s.Handle.ToString(), name = s.Name, analysis = State(s), slopeUnits = "rise/run; 0.05=5%" };
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        var surface = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface"));
        CorridorEditing.Guard(db, tr, surface); r["surface"] = surface.Handle.ToString(); r["analysisState"] = State(surface);
        r["surfaceState"] = surface.ComputeFingerPrint().ToString("X");
        if (CivilObjectAccess.Text(r, "operation") == "surface.waterdrop")
        {
            Point3d p = PrimitiveAccess.Point(r["point"]); surface.FindElevationAtXY(p.X, p.Y); PrimitiveAccess.Layer(db, tr, r);
            details.Add("지표면의 실제 물 흐름 경로를 3D 폴리선으로 생성합니다. 강우·관망 수리 해석은 수행하지 않습니다.");
        }
        else
        {
            string kind = CivilObjectAccess.Text(r, "kind"); if (kind is not ("elevation" or "slope")) throw new ArgumentException("표고 또는 경사 분석을 지정하세요.");
            if (r["bands"] is not JsonArray bands || bands.Count > 100) throw new ArgumentException("전체 분석 구간 0~100개를 지정하세요. 빈 목록은 제거입니다.");
            double last = double.NegativeInfinity;
            foreach (JsonNode? node in bands)
            {
                double min = CivilObjectAccess.Number(node!["min"]), max = CivilObjectAccess.Number(node["max"]); int color = node["color"]!.GetValue<int>();
                if (min >= max || min < last || color < 1 || color > 255 || (kind == "slope" && min < 0)) throw new ArgumentException("겹치지 않는 증가 구간과 ACI 1~255를 지정하세요. 경사는 0.05=5%입니다."); last = max;
            }
            details.Add("선택한 분석 종류의 전체 구간을 교체합니다. 화면 표시는 지표면 스타일의 분석 구성요소 켜짐 상태에 따릅니다.");
        }
        details.AddRange(CivilPlanDetails.Describe(r)); return CivilObjectAccess.Text(r, "operation") == "surface.waterdrop" ? "물 흐름 경로 생성" : "지표면 분석 구간 수정";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var s = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface")); s.UpgradeOpen(); using var analysis = s.Analysis;
        if (CivilObjectAccess.Text(r, "operation") == "surface.waterdrop")
        {
            Point3d p = PrimitiveAccess.Point(r["point"]);
            ObjectId[] ids = analysis.CreateWaterdrop(new Point2d(p.X, p.Y), WaterdropObjectType.Polyline3D).Cast<ObjectId>().ToArray();
            if (ids.Length == 0) throw new ArgumentException("물 흐름 경로가 생성되지 않았습니다.");
            foreach (ObjectId id in ids) ((Autodesk.AutoCAD.DatabaseServices.Entity)tr.GetObject(id, OpenMode.ForWrite)).LayerId = PrimitiveAccess.Layer(db, tr, r);
            return new { created = ids.Select(id => id.Handle.ToString()).ToArray() };
        }
        var bands = ((JsonArray)r["bands"]!).OfType<JsonObject>().ToArray();
        Color C(JsonObject b) => Color.FromColorIndex(ColorMethod.ByAci, (short)b["color"]!.GetValue<int>());
        if (CivilObjectAccess.Text(r, "kind") == "elevation") analysis.SetElevationData(bands.Select(b => new SurfaceAnalysisElevationData(CivilObjectAccess.Number(b["min"]), CivilObjectAccess.Number(b["max"]), C(b))).ToArray());
        else analysis.SetSlopeData(bands.Select(b => new SurfaceAnalysisSlopeData(CivilObjectAccess.Number(b["min"]), CivilObjectAccess.Number(b["max"]), C(b))).ToArray());
        return new { handle = s.Handle.ToString(), analysis = State(s) };
    }
}
