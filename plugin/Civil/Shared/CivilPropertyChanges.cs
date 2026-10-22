using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using CivilEntity = Autodesk.Civil.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

internal static class CivilPropertyChanges
{
    public static void Validate(Database database, Transaction transaction, JsonObject request,
        CivilEntity? entity, string kind, List<string> details)
    {
        if (request["style"] is not null || entity is null)
        {
            ObjectId id = CivilObjectAccess.Style(transaction, database, kind, request["style"]?.ToString());
            string name = ((Autodesk.Civil.DatabaseServices.Styles.StyleBase)
                transaction.GetObject(id, OpenMode.ForRead)).Name;
            request["style"] = name;
            details.Add($"스타일: {entity?.StyleName ?? "(새 객체)"} → {name}");
        }

        if (request["layer"] is not null || entity is null)
        {
            ObjectId id = CivilObjectAccess.Layer(transaction, database, request["layer"]?.ToString());
            string name = ((LayerTableRecord)transaction.GetObject(id, OpenMode.ForRead)).Name;
            request["layer"] = name;
            details.Add($"레이어: {entity?.Layer ?? "(새 객체)"} → {name}");
        }

        if (request["description"] is not null)
        {
            string description = CivilObjectAccess.Text(request, "description");
            if (description.Length > 1000)
            {
                throw new ArgumentException("설명은 1000자 이하로 주세요.");
            }

            details.Add($"설명: {entity?.Description} → {description}");
        }
    }

    public static void Apply(Database database, Transaction transaction, JsonObject request,
        CivilEntity entity, string kind)
    {
        if (request["newName"] is not null)
        {
            entity.Name = CivilObjectAccess.Text(request, "newName");
        }

        if (request["description"] is not null)
        {
            entity.Description = CivilObjectAccess.Text(request, "description");
        }

        if (request["style"] is not null)
        {
            entity.StyleId = CivilObjectAccess.Style(transaction, database, kind, request["style"]?.ToString());
        }

        if (request["layer"] is not null)
        {
            entity.LayerId = CivilObjectAccess.Layer(transaction, database, request["layer"]?.ToString());
        }
    }
}
