using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Surface = Autodesk.Civil.DatabaseServices.Surface;

namespace MyCivil3DMcp.Plugin;

// 관·구조물을 임의로 배치하지 않는다. 관망 컨테이너와 기준 객체 속성만 다룬다.
internal static class NetworkProperties
{
    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "network.create";
        Network? network = create ? null : CivilObjectAccess.Find<Network>(transaction, database,
            CivilObjectAccess.Text(request, "network"));
        if (network is not null)
        {
            CivilObjectAccess.Editable(network);
            CivilObjectAccess.WritableLayer(transaction, network.LayerId);
            request["network"] = network.Handle.ToString();
            details.Add($"대상: {network.Name} [{network.Handle}], 관 {network.GetPipeIds().Count}개·구조물 {network.GetStructureIds().Count}개 유지");
        }

        bool hasChanges = new[] { "newName", "description", "layer", "referenceAlignment", "referenceSurface", "partsList" }
            .Any(key => request[key] is not null);
        if (!create && !hasChanges)
        {
            throw new ArgumentException("변경할 관망 속성을 지정하세요.");
        }

        ValidateProperties(database, transaction, request, network, create, details);
        ValidateReferences(database, transaction, request, network, details);
        details.Add(create ? "빈 중력식 관망을 만듭니다. 관·구조물은 생성하지 않습니다."
            : "부품 형상·연결·관경은 유지합니다. 기준 객체 변경은 관련 주석과 이후 설계에 영향을 줄 수 있습니다.");
        return create ? $"관망 {request["name"]} 생성" : $"관망 {network!.Name} 속성 수정";
    }

    private static void ValidateProperties(Database database, Transaction transaction, JsonObject request,
        Network? network, bool create, List<string> details)
    {
        string nameKey = create ? "name" : "newName";
        if (request[nameKey] is not null || create)
        {
            string name = CivilObjectAccess.Text(request, nameKey);
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ArgumentException("관망 이름이 필요합니다.");
            }

            CivilObjectAccess.FreeName<Network>(transaction, database, name, network?.ObjectId ?? ObjectId.Null);
            details.Add($"이름: {network?.Name ?? "(새 관망)"} → {name}");
        }

        if (create || request["layer"] is not null)
        {
            ObjectId layer = CivilObjectAccess.Layer(transaction, database, request["layer"]?.ToString());
            CivilObjectAccess.WritableLayer(transaction, layer);
            request["layer"] = ((LayerTableRecord)transaction.GetObject(layer, OpenMode.ForRead)).Name;
            details.Add($"관망 레이어: {network?.Layer ?? "(새 관망)"} → {request["layer"]} (소속 부품 레이어는 유지)");
        }

        if (request["description"] is not null)
        {
            string description = CivilObjectAccess.Text(request, "description");
            if (description.Length > 1000)
            {
                throw new ArgumentException("설명은 1000자 이하로 주세요.");
            }

            details.Add($"설명: {network?.Description} → {description}");
        }
    }

    private static void ValidateReferences(Database database, Transaction transaction, JsonObject request,
        Network? network, List<string> details)
    {
        if (request["partsList"] is not null)
        {
            var list = NetworkCatalog.FindList(database, transaction, CivilObjectAccess.Text(request, "partsList"));
            request["partsList"] = list.Handle.ToString();
            details.Add($"부품 목록: {network?.PartsListName} → {list.Name}. 기존 부품 규격은 교체하지 않습니다.");
        }

        if (request["referenceAlignment"] is not null)
        {
            Alignment alignment = CivilObjectAccess.Find<Alignment>(transaction, database,
                CivilObjectAccess.Text(request, "referenceAlignment"));
            request["referenceAlignment"] = alignment.Handle.ToString();
            details.Add($"기준 선형: {network?.ReferenceAlignmentName} → {alignment.Name} [{alignment.Handle}]");
        }

        if (request["referenceSurface"] is not null)
        {
            Surface surface = CivilObjectAccess.Find<Surface>(transaction, database,
                CivilObjectAccess.Text(request, "referenceSurface"));
            request["referenceSurface"] = surface.Handle.ToString();
            details.Add($"기준 지표면: {network?.ReferenceSurfaceName} → {surface.Name} [{surface.Handle}]");
        }
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "network.create";
        ObjectId id;
        if (create)
        {
            string name = CivilObjectAccess.Text(request, "name");
            id = Network.Create(CivilDocument.GetCivilDocument(database), ref name);
        }
        else
        {
            id = CivilObjectAccess.Find<Network>(transaction, database, CivilObjectAccess.Text(request, "network")).ObjectId;
        }

        Network network = (Network)transaction.GetObject(id, OpenMode.ForWrite);
        if (request["partsList"] is not null)
        {
            network.PartsListId = NetworkCatalog.FindList(database, transaction,
                CivilObjectAccess.Text(request, "partsList")).ObjectId;
        }

        if (request["newName"] is not null)
        {
            network.Name = CivilObjectAccess.Text(request, "newName");
        }

        if (request["description"] is not null)
        {
            network.Description = CivilObjectAccess.Text(request, "description");
        }

        if (request["layer"] is not null)
        {
            network.LayerId = CivilObjectAccess.Layer(transaction, database, request["layer"]!.ToString());
        }

        if (request["referenceAlignment"] is not null)
        {
            network.ReferenceAlignmentId = CivilObjectAccess.Find<Alignment>(transaction, database,
                CivilObjectAccess.Text(request, "referenceAlignment")).ObjectId;
        }

        if (request["referenceSurface"] is not null)
        {
            network.ReferenceSurfaceId = CivilObjectAccess.Find<Surface>(transaction, database,
                CivilObjectAccess.Text(request, "referenceSurface")).ObjectId;
        }

        return new { name = network.Name, handle = network.Handle.ToString(),
            pipes = network.GetPipeIds().Count, structures = network.GetStructureIds().Count };
    }
}
