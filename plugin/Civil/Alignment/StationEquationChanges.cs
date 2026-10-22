using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class StationEquationChanges
{
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        Alignment a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment"));
        CorridorEditing.Guard(db, tr, a); r["alignment"] = a.Handle.ToString();
        // Station equations change the station interpretation of dependent profiles, sections and corridors.
        var children = a.GetProfileIds().Cast<ObjectId>().Concat(a.GetProfileViewIds().Cast<ObjectId>())
            .Concat(a.GetSampleLineGroupIds().Cast<ObjectId>()).ToArray();
        foreach (ObjectId id in children) CorridorEditing.Guard(db, tr, (Autodesk.Civil.DatabaseServices.Entity)tr.GetObject(id, OpenMode.ForRead));
        foreach (SampleLine l in SectionChanges.Lines(db, tr).Where(l => children.Contains(l.GroupId)))
        {
            CorridorEditing.Guard(db, tr, l);
            foreach (ObjectId id in l.GetSectionIds().Cast<ObjectId>().Concat(l.GetSectionViewIds().Cast<ObjectId>()))
                CorridorEditing.Guard(db, tr, (Autodesk.Civil.DatabaseServices.Entity)tr.GetObject(id, OpenMode.ForRead));
        }
        foreach (Corridor c in CorridorChanges.Objects<Corridor>(db, tr).Where(c => c.Baselines.Any(b => !b.IsFeatureLineBased() && b.AlignmentId == a.ObjectId)))
            CorridorEditing.Guard(db, tr, c);
        r["sourceState"] = new JsonObject { ["fingerprint"] = a.ComputeFingerPrint().ToString("X"),
            ["equations"] = new JsonArray(a.StationEquations.Select(e => (JsonNode)new JsonObject { ["rawStationBack"] = e.RawStationBack,
                ["stationAhead"] = e.StationAhead, ["type"] = e.EquationType.ToString() }).ToArray()) };
        if (r["equations"] is not JsonArray equations || equations.Count > 100) throw new ArgumentException("측점 방정식 전체 목록(0~100개)을 지정하세요.");
        double last = double.NegativeInfinity;
        foreach (JsonNode? node in equations)
        {
            if (node?["comment"] is not null) throw new ArgumentException("2025 API는 방정식 주석 편집을 지원하지 않습니다.");
            double raw = CivilObjectAccess.Number(node!["rawStationBack"]); CivilObjectAccess.Number(node["stationAhead"]);
            if (raw <= last || raw <= a.StartingStation || raw >= a.StartingStation + a.Length) throw new ArgumentException("원시 측점은 선형 내부의 증가 순서로 지정하세요.");
            if (!Enum.TryParse<StationEquationType>(node["type"]!.GetValue<string>(), out var type) || !Enum.IsDefined(type)) throw new ArgumentException("Increasing 또는 Decreasing 종류를 지정하세요.");
            last = raw;
        }
        details.Add($"{a.Name}: 기존 {a.StationEquations.Count}개를 명시한 {equations.Count}개로 교체합니다. 빈 목록은 전체 제거입니다.");
        details.Add("원시 측점은 방정식 적용 전 API 측점입니다. 선형 형상은 유지되며 종단·횡단·라벨의 측점 표기가 변경될 수 있습니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return "선형 측점 방정식 교체";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment")); a.UpgradeOpen();
        while (a.StationEquations.Count > 0) a.StationEquations.Remove(a.StationEquations.Count - 1);
        foreach (JsonNode? node in (JsonArray)r["equations"]!)
        {
            a.StationEquations.Add(CivilObjectAccess.Number(node!["rawStationBack"]), CivilObjectAccess.Number(node["stationAhead"]), Enum.Parse<StationEquationType>(node["type"]!.GetValue<string>()));
        }
        return new { handle = a.Handle.ToString(), count = a.StationEquations.Count };
    }
}
