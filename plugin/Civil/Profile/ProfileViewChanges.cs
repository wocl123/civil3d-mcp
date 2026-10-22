using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class ProfileViewChanges
{
    public static object List(Document document, int offset, int limit)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        ProfileView[] views = CivilObjectAccess.All<ProfileView>(transaction, document.Database)
            .OrderBy(view => view.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        return new { total = views.Length, offset, items = views.Skip(offset).Take(limit).Select(view => new
        {
            name = view.Name, handle = view.Handle.ToString(), alignment = view.AlignmentName,
            layer = view.Layer, style = view.StyleName, position = PrimitiveAccess.JsonPoint(view.Location),
            description = view.Description
        }).ToArray(), hasMore = offset + limit < views.Length };
    }

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "profileView.create";
        ProfileView? view = create ? null : CivilObjectAccess.Find<ProfileView>(transaction, database,
            CivilObjectAccess.Text(request, "profileView"));
        if (view is not null)
        {
            CivilObjectAccess.Editable(view);
            CivilObjectAccess.WritableLayer(transaction, view.LayerId);
            request["profileView"] = view.Handle.ToString();
            details.Add($"대상: {view.Name} [{view.Handle}], 선형 {view.AlignmentName}");
        }
        else
        {
            Alignment alignment = CivilObjectAccess.Find<Alignment>(transaction, database,
                CivilObjectAccess.Text(request, "alignment"));
            request["alignment"] = alignment.Handle.ToString();
            details.Add($"선형: {alignment.Name} [{alignment.Handle}], 측점 {alignment.StartingStation}~{alignment.EndingStation}");
            details.Add("단일 종단뷰 격자를 만듭니다. 기본 밴드·표시 설정을 사용하며 종단 데이터는 생성·수정하지 않습니다.");
        }
        bool hasChanges = new[] { "newName", "description", "style", "layer", "position" }
            .Any(property => request[property] is not null);
        if (!create && !hasChanges)
        {
            throw new ArgumentException("변경할 종단뷰 속성을 지정하세요.");
        }

        ValidateProperties(database, transaction, request, view, create, details);
        return create ? $"종단뷰 {request["name"]} 생성" : $"종단뷰 {view!.Name} 수정";
    }

    private static void ValidateProperties(Database database, Transaction transaction, JsonObject request,
        ProfileView? view, bool create, List<string> details)
    {
        string key = create ? "name" : "newName";
        if (create || request[key] is not null)
        {
            string name = CivilObjectAccess.Text(request, key);
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ArgumentException("종단뷰 이름이 필요합니다.");
            }

            CivilObjectAccess.FreeName<ProfileView>(transaction, database, name, view?.ObjectId ?? ObjectId.Null);
            details.Add($"이름: {view?.Name ?? "(새 종단뷰)"} → {name}");
        }
        CivilPropertyChanges.Validate(database, transaction, request, view, "profileView", details);
        if (create || request["layer"] is not null)
        {
            ObjectId layer = CivilObjectAccess.Layer(transaction, database, request["layer"]?.ToString());
            CivilObjectAccess.WritableLayer(transaction, layer);
        }

        if (create || request["position"] is not null)
        {
            var position = PrimitiveAccess.Point(request["position"]);
            string before = view is null ? "(새 종단뷰)" : PrimitiveAccess.PointText(view.Location);
            details.Add($"삽입 위치: {before} → {PrimitiveAccess.PointText(position)}");
        }
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "profileView.create";
        ObjectId id;
        if (create)
        {
            Alignment alignment = CivilObjectAccess.Find<Alignment>(transaction, database,
                CivilObjectAccess.Text(request, "alignment"));
            id = ProfileView.Create(alignment.ObjectId, PrimitiveAccess.Point(request["position"]));
        }
        else
        {
            id = CivilObjectAccess.Find<ProfileView>(transaction, database,
                CivilObjectAccess.Text(request, "profileView")).ObjectId;
        }

        ProfileView view = (ProfileView)transaction.GetObject(id, OpenMode.ForWrite);
        if (create)
        {
            view.Name = CivilObjectAccess.Text(request, "name");
        }

        CivilPropertyChanges.Apply(database, transaction, request, view, "profileView");
        if (request["position"] is not null)
        {
            view.Location = PrimitiveAccess.Point(request["position"]);
        }

        return new { name = view.Name, handle = view.Handle.ToString(), position = PrimitiveAccess.JsonPoint(view.Location) };
    }
}
