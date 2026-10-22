using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace MyCivil3DMcp.Plugin;

internal static class NetworkCatalog
{
    internal sealed record Selection(PartsList List, PartFamily Family, PartSize Size);

    internal static PartsList FindList(Database database, Transaction transaction, string key)
    {
        return CivilDocument.GetCivilDocument(database).Styles.PartsListSet.Cast<ObjectId>()
            .Select(id => (PartsList)transaction.GetObject(id, OpenMode.ForRead))
            .SingleOrDefault(list => Matches(list.Name, list.Handle.ToString(), key))
            ?? throw new ArgumentException("부품 목록이 없습니다. list_pipe_parts로 목록을 조회하세요.");
    }

    private static bool Matches(string name, string handle, string key) =>
        name.Equals(key, StringComparison.OrdinalIgnoreCase) || handle.Equals(key, StringComparison.OrdinalIgnoreCase);

    private static PartFamily[] Families(Transaction transaction, PartsList list, string kind)
    {
        DomainType domain = kind switch
        {
            "pipe" => DomainType.Pipe,
            "structure" => DomainType.Structure,
            _ => throw new ArgumentException("부품 종류는 pipe 또는 structure입니다.")
        };
        return list.GetPartFamilyIdsByDomain(domain).Cast<ObjectId>()
            .Select(id => (PartFamily)transaction.GetObject(id, OpenMode.ForRead)).ToArray();
    }

    internal static Selection Select(Database database, Transaction transaction, Network network,
        JsonObject request, string kind)
    {
        if (network.PartsListId.IsNull)
        {
            throw new ArgumentException("관망에 부품 목록이 없습니다. 관망 속성에서 partsList를 지정하세요.");
        }

        PartsList list = (PartsList)transaction.GetObject(network.PartsListId, OpenMode.ForRead);
        string familyKey = CivilObjectAccess.Text(request, "family");
        PartFamily family = Families(transaction, list, kind)
            .SingleOrDefault(item => Matches(item.Name, item.Handle.ToString(), familyKey))
            ?? throw new ArgumentException("지정한 종류의 부품군이 관망 부품 목록에 없습니다. list_pipe_parts를 조회하세요.");
        string sizeKey = CivilObjectAccess.Text(request, "size");
        PartSize size = Enumerable.Range(0, family.PartSizeCount)
            .Select(index => (PartSize)transaction.GetObject(family[index], OpenMode.ForRead))
            .SingleOrDefault(item => Matches(item.Name, item.Handle.ToString(), sizeKey))
            ?? throw new ArgumentException("선택한 부품군에 규격이 없습니다. 카탈로그 규격 이름/핸들을 사용하세요.");
        request["family"] = family.Handle.ToString();
        request["size"] = size.Handle.ToString();
        return new Selection(list, family, size);
    }

    public static object List(Document document, JsonObject request, int offset, int limit)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Database database = document.Database;
        if (request["partsList"] is null)
        {
            var lists = CivilDocument.GetCivilDocument(database).Styles.PartsListSet.Cast<ObjectId>()
                .Select(id => (PartsList)transaction.GetObject(id, OpenMode.ForRead))
                .Select(list => new { name = list.Name, handle = list.Handle.ToString(), families = list.PartFamilyCount }).ToArray();
            return new { level = "lists", total = lists.Length, offset, items = lists.Skip(offset).Take(limit).ToArray(),
                hasMore = offset + limit < lists.Length };
        }

        PartsList selected = FindList(database, transaction, CivilObjectAccess.Text(request, "partsList"));
        PartFamily[] families = Families(transaction, selected, request["kind"]?.ToString() ?? "pipe");
        if (request["family"] is null)
        {
            var items = families.Select(item => new { name = item.Name, handle = item.Handle.ToString(),
                description = item.Description, sizes = item.PartSizeCount }).ToArray();
            return new { level = "families", partsList = selected.Name, total = items.Length, offset,
                items = items.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < items.Length };
        }

        string key = CivilObjectAccess.Text(request, "family");
        PartFamily family = families.SingleOrDefault(item => Matches(item.Name, item.Handle.ToString(), key))
            ?? throw new ArgumentException("선택한 부품 목록/종류에 해당 부품군이 없습니다.");
        var sizes = Enumerable.Range(0, family.PartSizeCount)
            .Select(index => (PartSize)transaction.GetObject(family[index], OpenMode.ForRead))
            .Select(item => new { name = item.Name, handle = item.Handle.ToString(), description = item.Description }).ToArray();
        return new { level = "sizes", partsList = selected.Name, family = family.Name, total = sizes.Length, offset,
            items = sizes.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < sizes.Length };
    }
}
