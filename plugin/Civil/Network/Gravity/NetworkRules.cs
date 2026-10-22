using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class NetworkRules
{
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        Network network = CivilObjectAccess.Find<Network>(tr, db, CivilObjectAccess.Text(r, "network"));
        NetworkPartAccess.ValidateNetwork(db, tr, network, r, details, applyingRules: true);
        var parts = PrimitiveAccess.Targets<Part>(db, tr, r).Cast<Part>().ToArray();
        if (parts.Any(p => p.NetworkId != network.ObjectId)) throw new ArgumentException("같은 중력식 관망의 부품만 규칙을 적용합니다.");
        foreach (Part p in parts)
        {
            if (p.RuleSetStyleId.IsNull) throw new ArgumentException("규칙 세트가 없는 부품입니다.");
            details.Add($"{p.Name} [{p.Handle}]에 현재 규칙 세트 '{p.RuleSetStyleName}' 명시적 적용");
        }
        details.Add("이번 작업은 규칙 적용 요청입니다. 관 경사·토피·끝점·구조물 표고 등 규칙이 제어하는 값이 바뀔 수 있습니다. 규칙 실패 시 전체 작업을 취소합니다.");
        return "중력식 관망 규칙 적용";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var network = CivilObjectAccess.Find<Network>(tr, db, CivilObjectAccess.Text(r, "network")); network.UpgradeOpen();
        List<object> applied = new();
        foreach (JsonNode? h in (JsonArray)r["handles"]!)
        {
            Part p = (Part)CivilObjectAccess.ByHandle(tr, db, h!.ToString()); p.UpgradeOpen();
            if (!p.ApplyRules()) throw new ArgumentException($"{p.Name} 규칙 적용이 실패해 전체 작업을 취소합니다.");
            applied.Add(NetworkPartAccess.Info(p));
        }
        return new { parts = applied };
    }
}
