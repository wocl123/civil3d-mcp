using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

internal static class NetworkPartAccess
{
    internal static Part[] Parts(Transaction transaction, Network network) => network.GetPipeIds().Cast<ObjectId>()
        .Concat(network.GetStructureIds().Cast<ObjectId>()).Where(id => !id.IsErased)
        .Select(id => (Part)transaction.GetObject(id, OpenMode.ForRead)).ToArray();

    internal static T Find<T>(Database database, Transaction transaction, string handle) where T : Part =>
        CivilObjectAccess.ByHandle(transaction, database, handle) as T
        ?? throw new ArgumentException($"{typeof(T).Name} 핸들을 지정하세요.");

    internal static string? Handle(ObjectId id) => id.IsNull ? null : id.Handle.ToString();

    internal static object Info(Part part)
    {
        object geometry = part switch
        {
            Pipe pipe => new { start = PrimitiveAccess.JsonPoint(pipe.StartPoint), end = PrimitiveAccess.JsonPoint(pipe.EndPoint),
                startStructure = Handle(pipe.StartStructureId), endStructure = Handle(pipe.EndStructureId),
                innerDiameterOrWidth = pipe.InnerDiameterOrWidth, slope = pipe.Slope,
                resizeHold = pipe.HoldOnResizeType.ToString(), curved = pipe.SubEntityType.ToString() },
            Structure structure => new { position = PrimitiveAccess.JsonPoint(structure.Location),
                rotationDegrees = structure.Rotation * 180 / Math.PI, rimElevation = structure.RimElevation,
                sumpElevation = structure.SumpElevation, automaticRim = structure.AutomaticRimSurfaceAdjustment,
                connectedPipes = structure.ConnectedPipesCount },
            _ => throw new ArgumentException("중력식 관·구조물만 조회합니다.")
        };
        return new { name = part.Name, handle = part.Handle.ToString(), type = part.GetType().Name,
            network = part.NetworkName, layer = part.Layer, description = part.Description,
            family = part.PartFamilyName, size = part.PartSizeName, geometry };
    }

    public static object List(Document document, string networkKey, string? kind, int offset, int limit)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Network network = CivilObjectAccess.Find<Network>(transaction, document.Database, networkKey);
        Part[] parts = Parts(transaction, network).Where(part => kind is null
            || (kind == "pipe" && part is Pipe) || (kind == "structure" && part is Structure))
            .OrderBy(part => part.Name, StringComparer.OrdinalIgnoreCase).ThenBy(part => part.Handle.ToString()).ToArray();
        return new { network = network.Name, partsList = network.PartsListName, total = parts.Length, offset,
            items = parts.Skip(offset).Take(limit).Select(Info).ToArray(), hasMore = offset + limit < parts.Length };
    }

    internal static void ValidateNetwork(Database database, Transaction transaction, Network network,
        JsonObject request, List<string> details, bool applyingRules = false)
    {
        CivilObjectAccess.Editable(network);
        CivilObjectAccess.WritableLayer(transaction, network.LayerId);
        LayerObjects.Inventory inventory = LayerObjects.Describe(transaction, new Entity[] { network });
        if (inventory.Blocked is not null)
        {
            throw new ArgumentException("관망의 참조·종속 객체 상태로 편집할 수 없습니다. 원본과 소속 객체를 확인하세요.");
        }

        JsonArray state = new();
        foreach (LayerObjects.Target target in inventory.Objects.OrderBy(item => item.Handle, StringComparer.Ordinal))
        {
            Entity entity = CivilObjectAccess.ByHandle(transaction, database, target.Handle);
            CivilObjectAccess.WritableLayer(transaction, entity.LayerId);
            string fingerprint = entity is Part or Network
                ? ((Autodesk.Civil.DatabaseServices.Entity)entity).ComputeFingerPrint().ToString("X") : "";
            state.Add(new JsonObject { ["handle"] = target.Handle, ["type"] = target.Type,
                ["layer"] = target.Layer, ["fingerprint"] = fingerprint });
        }

        request["networkState"] = state;
        request["network"] = network.Handle.ToString();
        details.Add($"관망: {network.Name} [{network.Handle}], 부품 목록: {network.PartsListName}");
        details.Add($"소속 관 {network.GetPipeIds().Count}개·구조물 {network.GetStructureIds().Count}개와 연결 라벨의 잠금·참조 상태를 검사했습니다.");
        details.Add(applyingRules ? "현재 저장된 규칙을 명시적으로 적용합니다. 연결된 부품과 라벨이 재계산될 수 있습니다."
            : "설계 규칙은 자동 적용하지 않습니다. 연결된 부품과 라벨이 재계산될 수 있습니다.");
    }

    internal static void Name(Transaction transaction, Network network, Part? except, string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            throw new ArgumentException("부품 이름이 필요합니다.");
        }

        SymbolUtilityServices.ValidateSymbolName(name, false);
        bool duplicate = Parts(transaction, network).Any(part => part.ObjectId != except?.ObjectId
            && part.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        if (duplicate)
        {
            throw new ArgumentException($"관망에 부품 이름 '{name}'이 이미 있습니다.");
        }
    }
}
