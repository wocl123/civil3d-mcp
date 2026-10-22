using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.Runtime;

namespace MyCivil3DMcp.Plugin;

internal static class CorridorEditing
{
    private static JsonArray EnumValues(ParamLong parameter)
    {
        JsonArray values = new();
        uint count = parameter.EnumCount();
        if (count > 1000) throw new ArgumentException("매개변수 선택지 개수가 너무 많습니다.");
        for (uint i = 0; i < count; i++)
        {
            string name = "", displayName = ""; int value = 0; parameter.GetEnumData(i, ref name, ref displayName, ref value);
            values.Add(new JsonObject { ["name"] = name, ["displayName"] = displayName, ["value"] = value });
        }
        return values;
    }
    internal static JsonArray Parameters(Subassembly s) => new(s.ParamsDouble.Select(p => (JsonNode)new JsonObject {
        ["key"] = p.Key, ["type"] = "double", ["displayName"] = p.DisplayName, ["value"] = p.Value,
        ["readOnly"] = p.IsReadOnly, ["access"] = p.Access.ToString(), ["units"] = p.TypeInfo.ToString() })
        .Concat(s.ParamsLong.Select(p => (JsonNode)new JsonObject { ["key"] = p.Key, ["type"] = "integer", ["displayName"] = p.DisplayName,
            ["value"] = p.Value, ["readOnly"] = p.IsReadOnly, ["access"] = p.Access.ToString(), ["units"] = p.TypeInfo.ToString(), ["choices"] = EnumValues(p) }))
        .Concat(s.ParamsBool.Select(p => (JsonNode)new JsonObject { ["key"] = p.Key, ["type"] = "boolean", ["displayName"] = p.DisplayName,
            ["value"] = p.Value, ["readOnly"] = p.IsReadOnly, ["access"] = p.Access.ToString() }))
        .Concat(s.ParamsString.Select(p => (JsonNode)new JsonObject { ["key"] = p.Key, ["type"] = "string", ["displayName"] = p.DisplayName,
            ["value"] = p.Value, ["readOnly"] = p.IsReadOnly, ["access"] = p.Access.ToString() })).ToArray());
    private static Corridor Find(Database db, Transaction tr, JsonObject r) => SectionChanges.Find(CorridorChanges.Objects<Corridor>(db, tr), CivilObjectAccess.Text(r, "corridor"));
    private static Baseline Baseline(Corridor c, JsonObject r) => c.Baselines.SingleOrDefault(b => b.Name == CivilObjectAccess.Text(r, "baselineName"))
        ?? throw new ArgumentException("기준선이 없습니다.");
    internal static void Guard(Database db, Transaction tr, Autodesk.Civil.DatabaseServices.Entity e)
    {
        CivilObjectAccess.Editable(e); PrimitiveAccess.Writable(db, tr, e);
        foreach (ObjectId id in e.GetPersistentReactorIds())
            if (!id.IsNull && !id.IsErased && tr.GetObject(id, OpenMode.ForRead) is Autodesk.Civil.DatabaseServices.Entity child)
            { CivilObjectAccess.Editable(child); PrimitiveAccess.Writable(db, tr, child); }
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "subassembly.parameters")
        {
            var s = SectionChanges.Find(CorridorChanges.Objects<Subassembly>(db, tr), CivilObjectAccess.Text(r, "subassembly"));
            Guard(db, tr, s); r["subassembly"] = s.Handle.ToString(); r["parameterState"] = Parameters(s);
            var affected = CorridorChanges.Objects<Corridor>(db, tr).Where(c => s.HasParentAssembly
                && c.Baselines.Any(b => b.BaselineRegions.Any(g => g.AssemblyId == s.AssemblyId))).ToArray();
            foreach (var c in affected) Guard(db, tr, c);
            if (s.HasParentAssembly) Guard(db, tr, (Autodesk.Civil.DatabaseServices.Assembly)tr.GetObject(s.AssemblyId, OpenMode.ForRead));
            r["affectedCorridors"] = new JsonArray(affected.Select(c => (JsonNode)new JsonObject { ["handle"] = c.Handle.ToString(), ["fingerprint"] = c.ComputeFingerPrint().ToString("X") }).ToArray());
            if (r["parameters"] is not JsonArray parameters || parameters.Count is < 1 or > 100) throw new ArgumentException("매개변수 1~100개를 지정하세요.");
            HashSet<string> seen = new(StringComparer.Ordinal);
            foreach (JsonNode? item in parameters)
            {
                string key = item!["key"]!.GetValue<string>(); string type = item["type"]!.GetValue<string>();
                if (!seen.Add(key)) throw new ArgumentException("동일 매개변수를 두 번 지정할 수 없습니다.");
                JsonObject p = ((JsonArray)r["parameterState"]!).OfType<JsonObject>().SingleOrDefault(p => p["key"]!.ToString() == key && p["type"]!.ToString() == type)
                    ?? throw new ArgumentException("조회 결과에 없는 매개변수 키·형식입니다.");
                if (p["readOnly"]!.GetValue<bool>() || !p["access"]!.ToString().Contains("Input", StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException("입력 가능한 매개변수만 수정합니다.");
                if (type == "double") CivilObjectAccess.Number(item["value"]);
                else if (type == "integer")
                {
                    int value = item["value"]!.GetValue<int>();
                    JsonArray choices = (JsonArray)p["choices"]!;
                    if (choices.Count > 0 && !choices.Any(c => c!["value"]!.GetValue<int>() == value)) throw new ArgumentException("매개변수 선택지에 없는 정수 값입니다.");
                }
                else if (type == "boolean") item["value"]!.GetValue<bool>();
                else if (type == "string") item["value"]!.GetValue<string>();
                else throw new ArgumentException("지원하지 않는 매개변수 형식입니다.");
            }
            details.Add($"{s.Name} 입력값 수정, 관련 코리더 {affected.Length}개 재작성. 단위는 조회된 API 형식을 따릅니다.");
        }
        else
        {
            Corridor c = Find(db, tr, r); Guard(db, tr, c); r["corridor"] = c.Handle.ToString();
            r["sourceState"] = CorridorChanges.State(c); r["corridorFingerprint"] = c.ComputeFingerPrint().ToString("X");
            if (op == "corridor.solids")
            {
                if (r["codes"] is not JsonArray codes || codes.Count is < 1 or > 100) throw new ArgumentException("조회된 셰이프 코드 1~100개를 명시하세요.");
                string[] available = c.GetShapeCodes();
                if (codes.Any(code => !available.Contains(code!.GetValue<string>(), StringComparer.Ordinal))) throw new ArgumentException("코리더에 없는 셰이프 코드입니다.");
                PrimitiveAccess.Layer(db, tr, r);
                details.Add("현재 도면에 선택한 셰이프 코드의 솔리드를 추출합니다. 파일 내보내기는 아닙니다. 코드·재작성 상태에 따라 생성 결과가 달라집니다.");
                details.AddRange(CivilPlanDetails.Describe(r)); return "코리더 솔리드 추출";
            }
            Baseline b = Baseline(c, r);
            BaselineRegion region = b.BaselineRegions.SingleOrDefault(g => g.Name == CivilObjectAccess.Text(r, "regionName")) ?? throw new ArgumentException("구간이 없습니다.");
            if (op == "corridor.split")
            {
                if (region.OffsetBaselines.Count > 0 || region.AdditionalStations().Length > 0 || region.GetOverriddenStations().Length > 0)
                    throw new ArgumentException("오프셋 기준선·추가 측점·횡단 재지정이 있는 구간은 기본 분할 명령을 사용하세요.");
                double station = CivilObjectAccess.Number(r["station"]);
                if (station <= region.StartStation || station >= region.EndStation) throw new ArgumentException("분할 측점은 구간 내부여야 합니다.");
                string name = CivilObjectAccess.Text(r, "newName");
                if (b.BaselineRegions.Any(g => g.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 구간 이름이 있습니다.");
            }
            else if (op == "corridor.merge")
            {
                BaselineRegion other = b.BaselineRegions.SingleOrDefault(g => g.Name == CivilObjectAccess.Text(r, "otherRegion")) ?? throw new ArgumentException("병합할 구간이 없습니다.");
                if (other.Name == region.Name || Math.Abs(region.EndStation - other.StartStation) > 1e-6) throw new ArgumentException("앞 구간과 바로 이어지는 뒤 구간 순서로 지정하세요.");
                if (region.AssemblyId != other.AssemblyId || region.GetTargets().Count != 0 || other.GetTargets().Count != 0
                    || region.OffsetBaselines.Count > 0 || other.OffsetBaselines.Count > 0
                    || region.AdditionalStations().Length > 0 || other.AdditionalStations().Length > 0
                    || region.GetOverriddenStations().Length > 0 || other.GetOverriddenStations().Length > 0)
                    throw new ArgumentException("자동 병합은 같은 표준횡단이며 타깃이 없는 연속 구간만 지원합니다. 다른 경우 기본 구간 병합 명령을 사용하세요.");
                details.Add("앞 구간의 설정을 유지하고 뒤 구간을 제거합니다. 적용 간격 등 뒤 구간의 별도 설정은 사라집니다.");
            }
            else if (op != "corridor.removeRegion") throw new ArgumentException("알 수 없는 구간 편집입니다.");
            details.Add($"{c.Name}/{b.Name}/{region.Name}: {region.StartStation}~{region.EndStation}. 관련 지표면·횡단이 갱신됩니다.");
        }
        details.AddRange(CivilPlanDetails.Describe(r)); return CivilPlanDetails.Title(op);
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "subassembly.parameters")
        {
            var s = SectionChanges.Find(CorridorChanges.Objects<Subassembly>(db, tr), CivilObjectAccess.Text(r, "subassembly")); s.UpgradeOpen();
            foreach (JsonNode? item in (JsonArray)r["parameters"]!)
            {
                string key = item!["key"]!.GetValue<string>();
                switch (item["type"]!.GetValue<string>())
                {
                    case "double": s.ParamsDouble.Single(p => p.Key == key).Value = CivilObjectAccess.Number(item["value"]); break;
                    case "integer": s.ParamsLong.Single(p => p.Key == key).Value = item["value"]!.GetValue<int>(); break;
                    case "boolean": s.ParamsBool.Single(p => p.Key == key).Value = item["value"]!.GetValue<bool>(); break;
                    case "string": s.ParamsString.Single(p => p.Key == key).Value = item["value"]!.GetValue<string>(); break;
                }
            }
            s.Run();
            foreach (JsonNode? item in (JsonArray)r["affectedCorridors"]!) { var c = (Corridor)CivilObjectAccess.ByHandle(tr, db, item!["handle"]!.ToString()); c.UpgradeOpen(); c.Rebuild(); }
            return new { handle = s.Handle.ToString(), parameters = Parameters(s) };
        }
        Corridor corridor = Find(db, tr, r); corridor.UpgradeOpen();
        if (op == "corridor.solids")
        {
            var options = new ExportCorridorSolidsParams { ExportShapes = true, ExportLinks = false, CreateSolidForShape = true,
                IncludedCodes = ((JsonArray)r["codes"]!).Select(c => c!.GetValue<string>()).Distinct().ToArray() };
            ObjectId[] created = corridor.ExportSolids(options, db).Cast<ObjectId>().ToArray();
            if (created.Length == 0) throw new ArgumentException("해당 코드에서 솔리드가 생성되지 않았습니다. 코리더 단면과 재작성 상태를 확인하세요.");
            ObjectId layer = PrimitiveAccess.Layer(db, tr, r);
            foreach (ObjectId id in created) ((Autodesk.AutoCAD.DatabaseServices.Entity)tr.GetObject(id, OpenMode.ForWrite)).LayerId = layer;
            return new { created = created.Select(id => id.Handle.ToString()).ToArray() };
        }
        Baseline baseline = Baseline(corridor, r);
        BaselineRegion region = baseline.BaselineRegions.Single(g => g.Name == CivilObjectAccess.Text(r, "regionName"));
        int count = baseline.BaselineRegions.Count;
        if (op == "corridor.split")
        {
            double station = CivilObjectAccess.Number(r["station"]), end = region.EndStation;
            region.EndStation = station;
            BaselineRegion added = baseline.BaselineRegions.Add(CivilObjectAccess.Text(r, "newName"), region.AssemblyId, station, end);
            added.Match(region, RegionMatchType.All);
            if (baseline.BaselineRegions.Count != count + 1) throw new InvalidOperationException("구간 분할 결과 검증에 실패했습니다.");
        }
        else if (op == "corridor.merge")
        {
            BaselineRegion other = baseline.BaselineRegions.Single(g => g.Name == CivilObjectAccess.Text(r, "otherRegion"));
            double end = other.EndStation;
            if (!baseline.BaselineRegions.Remove(other)) throw new InvalidOperationException("뒤 구간 제거에 실패했습니다.");
            region.EndStation = end;
        }
        else if (!baseline.BaselineRegions.Remove(region)) throw new InvalidOperationException("구간 제거에 실패했습니다.");
        corridor.Rebuild(); return new { handle = corridor.Handle.ToString(), state = CorridorChanges.State(corridor) };
    }
}
