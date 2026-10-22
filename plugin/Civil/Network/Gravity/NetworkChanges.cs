using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

internal static class NetworkChanges
{
    public static object List(Document document, string? nameContains, int offset, int limit)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Network[] networks = CivilObjectAccess.All<Network>(transaction, document.Database)
            .Where(network => nameContains is null || network.Name.Contains(nameContains, StringComparison.OrdinalIgnoreCase))
            .OrderBy(network => network.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(network => network.Handle.ToString(), StringComparer.Ordinal).ToArray();
        return new { total = networks.Length, offset, items = networks.Skip(offset).Take(limit).Select(network => new
        {
            name = network.Name, handle = network.Handle.ToString(), layer = network.Layer,
            pipes = network.GetPipeIds().Count, structures = network.GetStructureIds().Count,
            isReference = network.IsReferenceObject || network.IsReferenceSubObject
        }).ToArray(), hasMore = offset + limit < networks.Length };
    }

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        int selectors = new[] { "network", "networks", "nameContains" }.Count(key => request[key] is not null);
        if (selectors != 1)
            throw new ArgumentException("관망 하나, 관망 목록 또는 이름 포함 조건 중 하나를 지정하세요.");

        Network[] networks;
        if (request["nameContains"] is not null)
        {
            string text = CivilObjectAccess.Text(request, "nameContains").Trim();
            if (text.Length == 0) throw new ArgumentException("빈 이름 조건으로 모든 관망을 지울 수 없습니다.");
            networks = CivilObjectAccess.All<Network>(transaction, database)
                .Where(network => network.Name.Contains(text, StringComparison.OrdinalIgnoreCase)).ToArray();
        }
        else
        {
            string[] keys = request["networks"] is JsonArray array
                ? array.Select(node => node!.GetValue<string>()).ToArray()
                : new[] { CivilObjectAccess.Text(request, "network") };
            networks = keys.Select(key => CivilObjectAccess.Find<Network>(transaction, database, key))
                .DistinctBy(network => network.ObjectId).ToArray();
        }
        networks = networks.OrderBy(network => network.Handle.ToString(), StringComparer.Ordinal).ToArray();
        if (networks.Length is < 1 or > 100)
            throw new ArgumentException("삭제할 관망은 1~100개여야 합니다. 이름 조건과 조회 결과를 확인하세요.");

        LayerObjects.Inventory inventory = LayerObjects.Describe(transaction, networks.Cast<Entity>().ToArray());
        if (inventory.Blocked is not null) throw new ArgumentException(inventory.Blocked);
        LayerObjects.Target[] targets = inventory.Objects.OrderBy(item => item.Handle, StringComparer.Ordinal).ToArray();
        foreach (LayerObjects.Target target in targets)
        {
            Entity entity = CivilObjectAccess.ByHandle(transaction, database, target.Handle);
            LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(entity.LayerId, OpenMode.ForRead);
            if (layer.IsLocked || layer.IsDependent)
                throw new ArgumentException($"삭제 대상 [{target.Handle}]의 레이어 '{layer.Name}'이 잠겼거나 외부참조입니다.");
        }
        foreach (Network network in networks)
            details.Add($"관망 {network.Name} [{network.Handle}]: 관 {network.GetPipeIds().Count}개, 구조물 {network.GetStructureIds().Count}개 삭제");
        int labels = targets.Count(target => target.Type.Contains("Label", StringComparison.Ordinal));
        details.Add($"관망 {networks.Length}개와 소속 관·구조물, 연결 라벨 {labels}개를 포함해 총 {targets.Length}개 삭제합니다. 다른 레이어의 소속 객체도 포함하며 레이어는 유지합니다.");
        request.Remove("network");
        request.Remove("nameContains");
        request["networks"] = new JsonArray(networks.Select(network => JsonValue.Create(network.Handle.ToString())).ToArray());
        // 재검증 때 같은 핸들·종류·레이어·소속 구성인지 CivilPlans의 지문으로 비교한다.
        request["targets"] = JsonSerializer.SerializeToNode(targets);
        return $"관망 {networks.Length}개 삭제";
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        LayerObjects.Target[] targets = request["targets"]!.Deserialize<LayerObjects.Target[]>()!;
        LayerObjects.Erase(database, transaction, targets);
        return new { deleted = targets.Select(target => target.Handle).ToArray(),
            networks = request["networks"]!.DeepClone() };
    }
}
