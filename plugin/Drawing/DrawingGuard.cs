using Autodesk.AutoCAD.ApplicationServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 팔레트 AI가 답하는 동안 사용자가 도면을 바꾸지 못하게 한다.
/// AI가 읽고 검토하고 바꿀 수도 있는 내용이 실제 도면과 어긋나지 않게 하려는 것.
/// 사용자가 시작한 명령은 막고(veto), 둘러보기(확대·이동·궤도·재생성)와 객체 선택은 된다.
/// AI가 일하는 동안 들어오는 플러그인 자체 요청은 통과한다.
/// </summary>
internal static class DrawingGuard
{
    // 화면만 움직이거나 다시 그리는 명령(+ 이 플러그인의 조회 명령).
    private static readonly HashSet<string> ViewOnly = new(StringComparer.OrdinalIgnoreCase)
    {
        "ZOOM", "PAN", "REDRAW", "REDRAWALL", "REGEN", "REGENALL", "3DORBIT", "3DFORBIT", "3DCORBIT",
        "NAVVCUBE", "NAVSWHEEL", "NAVBAR", "VIEW", "-VIEW", "VIEWRES", "MYC3DCHAT", "MYC3DCONNECTION", "MYC3DSTATUS", "MYC3DOBJECTS"
    };
    private static int _active;
    private static long _lastMessage;

    public static bool Active => _active > 0;

    // 답변 시작/끝. 겹쳐 불려도 되게 횟수로 센다.
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
        // 명령 이름이 없는 잠금은 AutoCAD 자체(화면, 자동 저장)에서 온 것이라 막지 않는다.
        if (command.Length == 0 || ViewOnly.Contains(command)) return;
        e.Veto();
        // 안내는 몇 초에 한 줄만(키를 누르고 있어도 명령줄이 넘치지 않게).
        if (Environment.TickCount64 - _lastMessage < 3000) return;
        _lastMessage = Environment.TickCount64;
        e.Document?.Editor.WriteMessage($"\nAI가 답변하는 동안에는 도면을 바꿀 수 없습니다({command} 취소). 화면 이동·확대와 선택은 됩니다.\n");
    }
}
