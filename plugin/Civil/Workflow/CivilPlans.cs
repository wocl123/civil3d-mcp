using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

// 읽기 전용 미리 보기의 정규화된 요청과 상태 지문을 저장한다. 적용 직전에 다시 검증한다.
internal static class CivilPlans
{
    internal sealed record Plan(JsonObject Request, string Fingerprint, string Summary,
        IReadOnlyList<string> Details, string Kind);

    public static Plan Preview(Document document, JsonObject? parameters)
    {
        JsonObject request = parameters?.DeepClone() as JsonObject
            ?? throw new ArgumentException("작업 요청이 필요합니다.");
        // Derived state must be rebuilt on every preview, never included recursively in its own details.
        request.Remove("coordinateContext");
        string operation = CivilObjectAccess.Text(request, "operation");
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<string> details = new();
        string summary = operation switch
        {
            "workflow.apply" => CivilWorkflowChanges.Validate(document, request, details),
            "batch.apply" => CivilBatchChanges.Validate(document, request, details),
            "native.assist" => NativeCivilWorkflows.Validate(document.Database, transaction, request, details),
            "drawing.display" => DrawingDisplay.Validate(document, transaction, request, details),
            _ => CivilOperationHandlers.Validate(operation, document.Database, transaction, request, details)
        };

        bool coordinateOperation = operation.EndsWith(".create", StringComparison.Ordinal)
            || operation.EndsWith(".edit", StringComparison.Ordinal);
        if (coordinateOperation)
        {
            CivilCoordinates.Context context = CivilCoordinates.Read(document.Database);
            request["coordinateContext"] = JsonSerializer.SerializeToNode(context);
            details.Insert(0, CivilCoordinates.Notice(context));
        }

        string content = request.ToJsonString() + JsonSerializer.Serialize(details);
        string fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content)));
        string kind = operation.EndsWith("create") || operation is "alignment.fromPolyline" or "label.engineering" or "surface.waterdrop" ? "create"
            : operation.EndsWith("delete") || operation.EndsWith("deleteMany") ? "delete" : "change";
        return new Plan(request, fingerprint, summary, details, kind);
    }

    public static object Apply(Document document, JsonObject? parameters)
    {
        JsonObject plan = parameters?["plan"] as JsonObject ?? throw new ArgumentException("계획이 필요합니다.");
        Plan current = Preview(document, plan["request"] as JsonObject);
        if (current.Fingerprint != CivilObjectAccess.Text(plan, "fingerprint"))
        {
            throw new ArgumentException("대상이 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
        }

        string operation = CivilObjectAccess.Text(current.Request, "operation");
        if (operation == "workflow.apply") return CivilWorkflowChanges.Apply(document, current.Request);
        if (operation == "batch.apply") return CivilBatchChanges.Apply(document, current.Request);
        if (operation == "native.assist") return NativeCivilWorkflows.Queue(document, current.Request);
        if (operation == "drawing.display")
        {
            return DrawingDisplay.Apply(document, current.Request);
        }

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        object result = CivilOperationHandlers.Apply(operation, document.Database, transaction, current.Request);
        transaction.Commit();
        return result;
    }
}
