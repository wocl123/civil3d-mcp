using Autodesk.AutoCAD.ApplicationServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Keeps the user from changing the drawing while the palette AI is answering, so what the
/// AI read, checked, and may change is still what is in the drawing. Commands the user starts
/// are vetoed; looking around (zoom, pan, orbit, regen) and selecting objects still work,
/// and the plug-in's own requests (which run while the AI works) pass.
/// </summary>
internal static class DrawingGuard
{
    // Commands that only move the view or redraw it.
    private static readonly HashSet<string> ViewOnly = new(StringComparer.OrdinalIgnoreCase)
    {
        "ZOOM", "PAN", "REDRAW", "REDRAWALL", "REGEN", "REGENALL", "3DORBIT", "3DFORBIT", "3DCORBIT",
        "NAVVCUBE", "NAVSWHEEL", "NAVBAR", "VIEW", "-VIEW", "VIEWRES", "MYC3DCHAT", "MYC3DCONNECTION", "MYC3DSTATUS", "MYC3DOBJECTS"
    };
    private static int _active;
    private static long _lastMessage;

    public static bool Active => _active > 0;

    public static void Begin()
    {
        if (_active++ == 0) App.DocumentManager.DocumentLockModeChanged += OnLockModeChanged;
    }

    public static void End()
    {
        if (_active == 0) return;
        if (--_active == 0) App.DocumentManager.DocumentLockModeChanged -= OnLockModeChanged;
    }

    private static void OnLockModeChanged(object? sender, DocumentLockModeChangedEventArgs e)
    {
        if (DrawingSelection.BridgeRunning) return;
        string command = e.GlobalCommandName.TrimStart('#', '\'', '_', '.').ToUpperInvariant();
        // Locks without a command come from AutoCAD itself (display, autosave), not the user.
        if (command.Length == 0 || ViewOnly.Contains(command)) return;
        e.Veto();
        // One line per few seconds, so holding a key does not flood the command line.
        if (Environment.TickCount64 - _lastMessage < 3000) return;
        _lastMessage = Environment.TickCount64;
        e.Document?.Editor.WriteMessage($"\nAI가 답변하는 동안에는 도면을 바꿀 수 없습니다({command} 취소). 화면 이동·확대와 선택은 됩니다.\n");
    }
}
