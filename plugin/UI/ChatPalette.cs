using Autodesk.AutoCAD.Windows;

namespace MyCivil3DMcp.Plugin;

// AI 팔레트 창(PaletteSet). 처음 열 때 한 번 만들고, 이후에는 보이기만 한다.
internal static class ChatPalette
{
    private static PaletteSet? _palette;
    private static ChatPanel? _panel;

    public static void Show()
    {
        if (_palette is null)
        {
            _palette = new PaletteSet("My Civil 3D AI", new Guid("A2E38D3C-7C1D-4F65-BD4A-246619B31F2C"))
            {
                Style = PaletteSetStyles.ShowCloseButton | PaletteSetStyles.Snappable,
                MinimumSize = new System.Drawing.Size(340, 420),
                Size = new System.Drawing.Size(420, 680),
                DockEnabled = DockSides.Left | DockSides.Right
            };
            _panel = new ChatPanel();
            // 질문을 입력하는 동안에만 키보드 포커스를 팔레트에 붙잡아 둔다(아니면 도면으로 돌아감).
            _panel.InputFocusChanged += focused => { if (_palette is not null) _palette.KeepFocus = focused; };
            _palette.AddVisual("AI", _panel);
        }
        // 열 때마다 AI 상태·사용량을 새로 읽는다.
        _palette.Visible = true;
        _ = _panel!.RefreshAllAsync();
    }

    public static void Dispose()
    {
        _palette?.Dispose();
        _palette = null;
        _panel = null;
    }
}
