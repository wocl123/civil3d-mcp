using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class CivilBatchChanges
{
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    public static string Validate(Document doc, JsonObject r, List<string> details)
    {
        if (r["steps"] is not JsonArray steps || steps.Count is < 1 or > 20) throw new ArgumentException("일괄 작업은 1~20개입니다.");
        JsonArray requests = new(), plans = new();
        foreach (JsonNode? step in steps)
        {
            if (step is not JsonObject input) throw new ArgumentException("각 단계는 작업 요청 객체여야 합니다.");
            string operation = CivilObjectAccess.Text(input, "operation");
            if (operation is "batch.apply" or "workflow.apply" or "native.assist" or "drawing.display") throw new ArgumentException("일괄 작업에 다른 일괄·연속 작업이나 대화형·화면 명령을 넣을 수 없습니다.");
            CivilPlans.Plan plan = CivilPlans.Preview(doc, input);
            plans.Add(JsonSerializer.SerializeToNode(plan, Json)); requests.Add(plan.Request.DeepClone());
            details.Add($"{plans.Count}. {plan.Summary}"); details.AddRange(plan.Details);
        }
        r["steps"] = requests; r["childPlans"] = plans;
        details.Add("하나의 트랜잭션으로 순서대로 적용합니다. 중간 실패 시 앞 단계도 취소하며 Undo 한 번으로 되돌립니다. 앞 단계에서 새로 만드는 객체를 뒤 단계의 입력으로 참조할 수 없습니다.");
        return $"Civil·작도 작업 {steps.Count}개 일괄 적용";
    }
    public static object Apply(Document doc, JsonObject r)
    {
        using Transaction transaction = doc.Database.TransactionManager.StartTransaction();
        List<object> results = new();
        foreach (JsonNode? child in (JsonArray)r["childPlans"]!)
            results.Add(CivilPlans.Apply(doc, new JsonObject { ["plan"] = child!.DeepClone() }));
        transaction.Commit(); return new { count = results.Count, results };
    }
}
