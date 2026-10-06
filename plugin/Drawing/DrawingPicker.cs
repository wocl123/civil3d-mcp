using System.Windows.Threading;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Asks the user to pick an object on the command line while the palette AI waits, so
/// the user points at it instead of choosing a handle from a list. Picking changes nothing.
/// An unanswered prompt is cancelled after the timeout, before the Node service gives up.
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

        bool timedOut = false;
        DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(timeoutSeconds) };
        timer.Tick += (_, _) =>
        {
            timer.Stop();
            timedOut = true;
            document.SendStringToExecute("\x03\x03", true, false, false);
        };
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
