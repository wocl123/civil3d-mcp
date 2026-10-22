using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

// Preview executes the SAME bounded, transaction-only steps under an always-aborted transaction.
// Temporary handles never enter the stored plan. References are resolved again during the real apply.
internal static class CivilWorkflowChanges
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly HashSet<string> Allowed = new(StringComparer.Ordinal) {
        "geometry.create", "alignment.fromPolyline", "profile.create", "surface.create", "featureLine.create", "assembly.create",
        "corridor.create", "corridor.baseline", "corridor.region", "corridor.surface", "corridor.rebuild",
        "network.create", "pressureNetwork.create", "sampleGroup.create", "sampleLine.create", "sectionView.create", "cogo.create",
        "propertyDefinition.change", "propertySet.change"
    };
    private static readonly HashSet<string> RefFields = new(StringComparer.Ordinal) {
        "source", "alignment", "profile", "surface", "assembly", "corridor", "network", "group", "sampleLine", "featureLine", "handles", "definition"
    };
    private static JsonNode? Resolve(JsonNode? node, IReadOnlyDictionary<string, JsonNode> results, string field = "")
    {
        if (node is JsonObject obj)
        {
            if (obj.ContainsKey("$ref"))
            {
                if (obj.Count != 1 || !RefFields.Contains(field)) throw new ArgumentException("참조는 대상 객체 필드에만 지정하세요.");
                string path = obj["$ref"]!.GetValue<string>();
                if (!Regex.IsMatch(path, "^[A-Za-z][A-Za-z0-9_]{0,31}\\.(handle|created\\.[0-9]{1,3})$")) throw new ArgumentException("참조는 step.handle 또는 step.created.0 형식입니다.");
                string[] parts = path.Split('.');
                if (!results.TryGetValue(parts[0], out JsonNode? value)) throw new ArgumentException("앞에서 생성한 단계만 참조할 수 있습니다.");
                foreach (string key in parts.Skip(1)) value = value is JsonArray array && int.TryParse(key, out int index)
                    ? index >= 0 && index < array.Count ? array[index] : null : value?[key];
                if (value is null || value.GetValueKind() != JsonValueKind.String || !Regex.IsMatch(value.GetValue<string>(), "^[0-9A-Fa-f]{1,16}$"))
                    throw new ArgumentException("참조 결과에 유효한 객체 핸들이 없습니다.");
                return value.DeepClone();
            }
            JsonObject copy = new(); foreach (var pair in obj) copy[pair.Key] = Resolve(pair.Value, results, pair.Key); return copy;
        }
        if (node is JsonArray values) return new JsonArray(values.Select(v => Resolve(v, results, field)).ToArray());
        return node?.DeepClone();
    }
    public static string Validate(Document doc, JsonObject r, List<string> details)
    {
        if (r["steps"] is not JsonArray steps || steps.Count is < 1 or > 12) throw new ArgumentException("연속 작업은 1~12단계입니다.");
        if (steps.ToJsonString().Length > 100000) throw new ArgumentException("연속 작업의 입력 크기를 줄이세요.");
        HashSet<string> ids = new(StringComparer.Ordinal);
        foreach (JsonNode? step in steps)
        {
            string id = step?["id"]?.GetValue<string>() ?? "";
            if (!Regex.IsMatch(id, "^[A-Za-z][A-Za-z0-9_]{0,31}$") || !ids.Add(id)) throw new ArgumentException("단계 ID는 중복 없는 영문 식별자입니다.");
            if (step?["request"] is not JsonObject request || !Allowed.Contains(CivilObjectAccess.Text(request, "operation")))
                throw new ArgumentException("이 연속 작업은 등록된 생성·코리더 구성 작업만 지원합니다. 파일·대화형·삭제·중첩 작업은 불가합니다.");
        }
        r["workflowRevision"] = DrawingRevisions.Of(doc.Database); r["workflowDrawing"] = DrawingRevisions.Id(doc.Database);
        var coordinates = CivilCoordinates.Read(doc.Database); r["workflowCoordinates"] = JsonSerializer.SerializeToNode(coordinates);
        details.Add(CivilCoordinates.Notice(coordinates));
        DrawingRevisions.ReadWithRollback(doc.Database, _ => { Execute(doc, steps); return true; });
        foreach (JsonNode? step in steps)
        {
            JsonObject request = step!["request"]!.AsObject();
            details.Add($"단계 {step["id"]}: {CivilPlanDetails.Title(CivilObjectAccess.Text(request, "operation"))}");
            details.AddRange(CivilPlanDetails.Describe(request));
        }
        details.Add("전체 순서를 롤백 미리 보기로 검증했습니다. 앞 단계 결과는 $ref로 연결되며, 적용 중 실패하면 전체 롤백하고 Undo 한 번으로 복원합니다.");
        return $"생성·설계 연속 작업 {steps.Count}단계";
    }
    private static JsonArray Execute(Document doc, JsonArray steps)
    {
        Dictionary<string, JsonNode> results = new(StringComparer.Ordinal); JsonArray outputs = new();
        foreach (JsonNode? step in steps)
        {
            string id = step!["id"]!.GetValue<string>();
            var input = (JsonObject)Resolve(step["request"], results)!;
            CivilPlans.Plan plan = CivilPlans.Preview(doc, input);
            object result = CivilPlans.Apply(doc, new JsonObject { ["plan"] = JsonSerializer.SerializeToNode(plan, Json) });
            JsonNode value = JsonSerializer.SerializeToNode(result, Json)!; results[id] = value;
            outputs.Add(new JsonObject { ["id"] = id, ["result"] = value.DeepClone() });
        }
        return outputs;
    }
    public static object Apply(Document doc, JsonObject r)
    {
        using Transaction transaction = doc.Database.TransactionManager.StartTransaction();
        JsonArray outputs = Execute(doc, (JsonArray)r["steps"]!); transaction.Commit();
        return new { count = outputs.Count, steps = outputs };
    }
}
