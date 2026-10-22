using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;

namespace MyCivil3DMcp.Plugin;

// 브리지 명령이 끝나며 PickFirst가 지워지므로, 전용 명령 안에서 선택을 복원한 뒤 뷰어를 실행한다.
internal static class DrawingViewer
{
    private sealed record Job(string DrawingId, string Revision, ObjectId[] Ids, long Created);
    private static readonly Dictionary<string, Job> Pending = new();

    public static string Queue(Document document, ObjectId[] ids)
    {
        string token = Prepare(document, ids);
        document.SendStringToExecute($"_.MYC3DOBJECTVIEWER {token} ", true, false, false);
        return token;
    }

    internal static string Prepare(Document document, ObjectId[] ids)
    {
        foreach (string expired in Pending.Where(item => Environment.TickCount64 - item.Value.Created > 30000)
            .Select(item => item.Key).ToArray())
        {
            Pending.Remove(expired);
        }

        if (Pending.Count >= 16)
        {
            throw new ArgumentException("객체뷰어 요청이 대기 중입니다. Civil 3D 명령 상태를 확인하세요.");
        }

        string token = Guid.NewGuid().ToString("N");
        Pending[token] = new Job(DrawingRevisions.Id(document.Database), DrawingRevisions.Of(document.Database),
            ids.ToArray(), Environment.TickCount64);
        return token;
    }

    internal static ObjectId[] Take(Document document, string token)
    {
        if (!Pending.Remove(token, out Job? job) || Environment.TickCount64 - job.Created > 30000)
        {
            throw new ArgumentException("객체뷰어 요청이 없거나 만료됐습니다. 팔레트에서 다시 요청하세요.");
        }

        bool sameDrawing = job.DrawingId == DrawingRevisions.Id(document.Database)
            && job.Revision == DrawingRevisions.Of(document.Database);
        bool valid = job.Ids.All(id => id.IsValid && !id.IsErased && id.Database == document.Database);
        if (!sameDrawing || !valid)
        {
            throw new ArgumentException("뷰어 요청 뒤 도면 또는 대상이 바뀌었습니다. 다시 요청하세요.");
        }

        return job.Ids;
    }

    public static void Open(Document document)
    {
        Editor editor = document.Editor;
        PromptResult input = editor.GetString(new PromptStringOptions("\n객체뷰어 요청 ID: ") { AllowSpaces = false });
        if (input.Status != PromptStatus.OK)
        {
            return;
        }

        try
        {
            ObjectId[] ids = Take(document, input.StringResult);
            editor.SetImpliedSelection(ids);
            editor.Command("_.AECOBJECTVIEWER");
        }
        catch (System.Exception ex)
        {
            NodeService.LogBridgeError("drawing.viewer", ex);
            editor.WriteMessage("\n객체뷰어 실행 실패: " + ex.Message);
        }
    }
}
