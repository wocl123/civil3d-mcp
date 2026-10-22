using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;

namespace MyCivil3DMcp.Plugin;

// 레이어 선택은 객체 선택과 현재 레이어 지정을 구분한다. 객체 분리는 AutoCAD의 기본 격리를 사용한다.
internal static class DrawingDisplay
{
    public static string Validate(Document document, Transaction transaction, JsonObject request, List<string> details)
    {
        string action = CivilObjectAccess.Text(request, "action");
        if (action == "restore")
        {
            details.Add("기본 객체 분리·숨기기를 해제합니다. 레이어 상태는 바꾸지 않습니다.");
            return "객체 분리 해제";
        }

        if (action is "selectLayer" or "currentLayer")
        {
            ValidateLayer(document.Database, transaction, request, action, details);
            if (action == "currentLayer")
            {
                return $"현재 레이어를 {request["layer"]}(으)로 변경";
            }
        }
        else if (action is not ("select" or "isolate" or "hide" or "viewer"))
        {
            throw new ArgumentException("알 수 없는 표시 작업입니다.");
        }

        ObjectId[] ids = Targets(document.Database, transaction, request);
        if (ids.Length == 0 || ids.Length > 1000)
        {
            throw new ArgumentException("표시할 객체는 1~1000개여야 합니다. 빈 레이어에는 선택할 객체가 없습니다.");
        }

        foreach (ObjectId id in ids)
        {
            Entity entity = (Entity)transaction.GetObject(id, OpenMode.ForRead);
            BlockTableRecord owner = (BlockTableRecord)transaction.GetObject(entity.OwnerId, OpenMode.ForRead);
            if (owner.ObjectId != document.Database.CurrentSpaceId)
            {
                throw new ArgumentException("현재 모형/배치 공간의 객체만 선택·분리할 수 있습니다.");
            }

            LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(entity.LayerId, OpenMode.ForRead);
            if (layer.IsFrozen || layer.IsOff)
            {
                throw new ArgumentException($"레이어 {layer.Name}이(가) 동결 또는 꺼짐 상태입니다. 먼저 해제하세요.");
            }

            details.Add($"{entity.GetType().Name} [{entity.Handle}], 레이어 {entity.Layer}");
        }

        request["handles"] = new JsonArray(ids.Select(id => JsonValue.Create(id.Handle.ToString())).ToArray());
        if (action == "isolate")
        {
            details.Add("같은 레이어의 객체도 개별적으로 분리합니다. 기본 객체 분리 해제로 복원할 수 있습니다.");
        }

        string verb = action switch
        {
            "isolate" => "분리", "hide" => "숨기기", "viewer" => "객체뷰어 열기", _ => "선택"
        };
        return $"객체 {ids.Length}개 {verb}";
    }

    private static void ValidateLayer(Database database, Transaction transaction, JsonObject request,
        string action, List<string> details)
    {
        ObjectId id = CivilObjectAccess.Layer(transaction, database, CivilObjectAccess.Text(request, "layer"));
        LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(id, OpenMode.ForRead);
        if (layer.IsFrozen || layer.IsOff)
        {
            throw new ArgumentException("동결되거나 꺼진 레이어는 먼저 해동·켜기 후 선택하세요.");
        }

        request["layer"] = layer.Name;
        if (action == "currentLayer")
        {
            LayerTableRecord current = (LayerTableRecord)transaction.GetObject(database.Clayer, OpenMode.ForRead);
            details.Add($"현재 레이어: {current.Name} → {layer.Name}");
        }
    }

    private static ObjectId[] Targets(Database database, Transaction transaction, JsonObject request)
    {
        if (CivilObjectAccess.Text(request, "action") == "selectLayer")
        {
            ObjectId layer = CivilObjectAccess.Layer(transaction, database, CivilObjectAccess.Text(request, "layer"));
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(database.CurrentSpaceId, OpenMode.ForRead);
            return space.Cast<ObjectId>().Where(id => !id.IsErased)
                .Where(id => transaction.GetObject(id, OpenMode.ForRead) is Entity entity && entity.LayerId == layer)
                .Take(1001).ToArray();
        }

        JsonArray handles = request["handles"] as JsonArray ?? throw new ArgumentException("객체 핸들이 필요합니다.");
        return handles.Select(node => CivilObjectAccess.ByHandle(transaction, database,
            node?.GetValue<string>() ?? "").ObjectId).Distinct().ToArray();
    }

    public static object Apply(Document document, JsonObject request)
    {
        string action = CivilObjectAccess.Text(request, "action");
        ObjectId[] ids = [];
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            if (action == "currentLayer")
            {
                document.Database.Clayer = CivilObjectAccess.Layer(transaction, document.Database,
                    CivilObjectAccess.Text(request, "layer"));
            }
            else if (action != "restore")
            {
                ids = Targets(document.Database, transaction, request);
            }

            transaction.Commit();
        }

        if (action == "viewer")
        {
            DrawingViewer.Queue(document, ids);
        }
        else
        {
            Execute(document.Editor, action, ids);
        }

        document.Editor.Regen();
        return new { action, handles = ids.Select(id => id.Handle.ToString()).ToArray(),
            layer = request["layer"]?.ToString(),
            message = action == "viewer" ? "객체뷰어 열기 요청을 전달했습니다." : "객체 선택·표시 작업을 완료했습니다.",
            undoAvailable = action is "isolate" or "hide" or "restore" };
    }

    private static void Execute(Editor editor, string action, ObjectId[] ids)
    {
        if (action is "select" or "selectLayer")
        {
            editor.SetImpliedSelection(ids);
        }
        else if (action is "isolate" or "hide")
        {
            string command = action == "isolate" ? "_.ISOLATEOBJECTS" : "_.HIDEOBJECTS";
            editor.Command(command, SelectionSet.FromObjectIds(ids), "");
        }
        else if (action == "restore")
        {
            editor.Command("_.UNISOLATEOBJECTS");
        }
    }
}
