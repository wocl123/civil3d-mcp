using System.Windows.Threading;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 팔레트 AI가 기다리는 동안 명령줄에서 사용자에게 객체를 고르게 한다.
/// 목록에서 핸들을 고르는 대신 도면에서 직접 가리키게 하려는 것. 고르기만 하고 아무것도 바꾸지 않는다.
/// 답이 없으면 제한 시간 뒤 취소한다(Node 서비스가 포기하기 전에).
/// </summary>
internal static class DrawingPicker
{
    public static PolylinePick PickPolyline(Document document, string? message, int timeoutSeconds)
    {
        PromptEntityOptions options = new($"\n{(string.IsNullOrWhiteSpace(message) ? "폴리라인을 선택하세요" : message.Trim())} (ESC 취소): ")
        {
            AllowNone = false
        };
        options.SetRejectMessage("\n2D 폴리라인만 선택할 수 있습니다.");
        options.AddAllowedClass(typeof(Polyline), true);

        // 제한 시간이 지나면 ESC 두 번을 보내 고르기를 끝낸다.
        bool timedOut = false;
        DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(timeoutSeconds) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            timedOut = true;
            document.SendStringToExecute("\x03\x03", true, false, false);
        };
        // 팔레트에 있던 포커스를 도면으로 옮겨 바로 클릭할 수 있게.
        try { Autodesk.AutoCAD.Internal.Utils.SetFocusToDwgView(); } catch (System.Exception) { }
        timer.Start();
        PromptEntityResult result;
        try { result = document.Editor.GetEntity(options); }
        finally { timer.Stop(); }
        if (result.Status != PromptStatus.OK) return new PolylinePick(timedOut ? "timeout" : "cancelled", null);

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Polyline polyline = (Polyline)transaction.GetObject(result.ObjectId, OpenMode.ForRead);
        return new PolylinePick("picked", DrawingQueries.Summarize(polyline));
    }
}
