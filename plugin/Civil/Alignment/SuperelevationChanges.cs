using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class SuperelevationChanges
{
    private static readonly SuperelevationCrossSegmentType[] Segments = Enum.GetValues<SuperelevationCrossSegmentType>();
    private static SuperelevationCurve Curve(Alignment a, string name)
    {
        var matches = a.SuperelevationCurves.Where(c => c.Name == name).ToArray();
        return matches.Length == 1 ? matches[0] : throw new ArgumentException("실제 편경사 곡선 이름을 지정하세요.");
    }
    private static void Slopes(JsonNode? node)
    {
        if (node is not JsonObject slopes || slopes.Count is < 1 or > 8) throw new ArgumentException("1~8개 차로·길어깨 경사를 지정하세요.");
        foreach (var pair in slopes)
            if (!Enum.TryParse<SuperelevationCrossSegmentType>(pair.Key, out var seg) || !Enum.IsDefined(seg) || Math.Abs(CivilObjectAccess.Number(pair.Value)) > 1)
                throw new ArgumentException("실제 횡단 구간 이름 및 -1~1 경사 비율을 지정하세요. 0.06=6%입니다.");
    }
    private static void Set(SuperelevationCurve curve, double station, JsonObject slopes, bool add)
    {
        if (add) curve.CriticalStations.Add(station, SuperelevationCriticalStationType.Manual, SuperelevationAttainmentRegionType.AutoAttainmentRegionType);
        using var s = curve.CriticalStations.GetCriticalStationAt(station, 1e-7);
        foreach (var pair in slopes) s.SetSlope(Enum.Parse<SuperelevationCrossSegmentType>(pair.Key), CivilObjectAccess.Number(pair.Value));
    }
    private static JsonArray State(Alignment a) => new(a.SuperelevationCurves.Select(c => (JsonNode)new JsonObject {
        ["name"] = c.Name, ["start"] = c.StartStation, ["end"] = c.EndStation,
        ["stations"] = new JsonArray(c.CriticalStations.Select(s => {
            using (s)
            {
                JsonObject slopes = new(); foreach (var seg in Segments)
                {
                    try { double v = s.GetSlope(seg); if (double.IsFinite(v)) slopes[seg.ToString()] = v; }
                    catch (Autodesk.AutoCAD.Runtime.Exception ex) when (ex.ErrorStatus == Autodesk.AutoCAD.Runtime.ErrorStatus.NotApplicable) { }
                }
                return (JsonNode)new JsonObject { ["station"] = s.Station, ["type"] = s.StationType.ToString(), ["slopes"] = slopes };
            }
        }).ToArray()) }).ToArray());
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
        => DrawingRevisions.ReadWithRollback(db, temporary => ValidateCore(db, temporary, r, details));
    private static string ValidateCore(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        var a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment"));
        CorridorEditing.Guard(db, tr, a);
        a.UpgradeOpen(); // Civil initializes superelevation caches even while reading; temporary transaction always aborts.
        if (a.IsConnectedAlignment || a.IsOffsetAlignment || a.StationEquations.Count > 0) throw new ArgumentException("연결·오프셋·측점 방정식 선형은 지원하지 않습니다.");
        foreach (var corridor in CorridorChanges.Objects<Corridor>(db, tr).Where(c => c.Baselines.Any(b => !b.IsFeatureLineBased() && b.AlignmentId == a.ObjectId))) CorridorEditing.Guard(db, tr, corridor);
        r["alignment"] = a.Handle.ToString(); r["sourceState"] = State(a); r["geometryState"] = a.ComputeFingerPrint().ToString("X");
        string action = CivilObjectAccess.Text(r, "action");
        if (action == "createCurve")
        {
            var first = a.Entities.EntityAtId(r["startEntityId"]!.GetValue<int>());
            var last = a.Entities.EntityAtId(r["endEntityId"]!.GetValue<int>());
            if (first.SubEntityCount < 1 || last.SubEntityCount < 1) throw new ArgumentException("실제 선형 요소 ID가 필요합니다.");
            if (a.SuperelevationCurves.Count > 0) throw new ArgumentException("사용자 편경사 곡선 초기화는 편경사 곡선이 없는 선형에서만 지원합니다.");
        }
        else if (action == "setTable")
        {
            Curve(a, CivilObjectAccess.Text(r, "curve"));
            if (r["stations"] is not JsonArray rows || rows.Count is < 1 or > 200) throw new ArgumentException("편경사 측점 표 1~200행을 지정하세요.");
            double prior = double.NegativeInfinity;
            foreach (JsonNode? row in rows)
            {
                double station = CivilObjectAccess.Number(row?["station"]);
                if (station < a.StartingStation || station > a.EndingStation || station <= prior + 1e-7) throw new ArgumentException("선형 범위 내 중복 없는 원시 측점을 증가 순서로 지정하세요.");
                Slopes(row!["slopes"]); prior = station;
            }
        }
        else
        {
            var c = Curve(a, CivilObjectAccess.Text(r, "curve")); double station = CivilObjectAccess.Number(r["station"]);
            if (station < a.StartingStation || station > a.EndingStation) throw new ArgumentException("원시 측점이 선형 범위를 벗어납니다.");
            var existing = c.CriticalStations.Where(s => Math.Abs(s.Station - station) < 1e-7).ToArray();
            try
            {
                if (action == "addStation")
                {
                    if (existing.Length > 0) throw new ArgumentException("이미 편경사 임계 측점이 있습니다. setSlopes를 사용하세요.");
                }
                else if (action is "setSlopes" or "removeStation")
                {
                    if (existing.Length != 1) throw new ArgumentException("정확히 하나의 기존 임계 측점이 필요합니다.");
                    if (action == "removeStation" && existing[0].StationType != SuperelevationCriticalStationType.Manual) throw new ArgumentException("수동 측점만 삭제할 수 있습니다.");
                }
                else throw new ArgumentException("createCurve/addStation/setSlopes/setTable/removeStation을 지정하세요.");
            }
            finally { foreach (var s in existing) s.Dispose(); }
            if (action is "addStation" or "setSlopes")
            {
                Slopes(r["slopes"]);
            }
        }
        details.Add("입력한 설계 경사를 실제 Civil 편경사 데이터에 기록합니다. 비율 0.06=6%, 부호는 API 횡단 구간 방향 기준입니다.");
        details.Add("설계 기준 파일로 자동 산정하지 않으며 코리더 재작성과 설계 기준 검토는 별도입니다. 기존 임계 측점은 유지합니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return "선형 편경사 자동 편집";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment")); a.UpgradeOpen();
        string action = CivilObjectAccess.Text(r, "action");
        if (action == "createCurve")
        {
            var first = a.Entities.EntityAtId(r["startEntityId"]!.GetValue<int>()); var last = a.Entities.EntityAtId(r["endEntityId"]!.GetValue<int>());
            a.SuperelevationCurves.AddUserDefinedCurve(first[0], last[last.SubEntityCount - 1]);
        }
        else if (action == "setTable")
        {
            var c = Curve(a, CivilObjectAccess.Text(r, "curve"));
            foreach (JsonObject row in ((JsonArray)r["stations"]!).OfType<JsonObject>())
            {
                double station = CivilObjectAccess.Number(row["station"]);
                Set(c, station, row["slopes"]!.AsObject(), !c.CriticalStations.IsCriticalStation(station, 1e-7));
            }
        }
        else
        {
            var c = Curve(a, CivilObjectAccess.Text(r, "curve")); double station = CivilObjectAccess.Number(r["station"]);
            if (action == "removeStation")
            {
                for (int i = 0; i < c.CriticalStations.Count; i++)
                {
                    using var s = c.CriticalStations[i]; if (Math.Abs(s.Station - station) < 1e-7) { c.CriticalStations.RemoveAt(i); break; }
                }
            }
            else
            {
                Set(c, station, (JsonObject)r["slopes"]!, action == "addStation");
            }
        }
        return new { handle = a.Handle.ToString(), curves = State(a) };
    }
}
