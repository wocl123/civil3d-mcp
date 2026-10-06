using Autodesk.AutoCAD.Windows;

namespace MyCivil3DMcp.Plugin;

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
            // Keep keyboard focus in the palette only while the user types a question.
            _panel.InputFocusChanged += focused => { if (_palette is not null) _palette.KeepFocus = focused; };
            _palette.AddVisual("AI", _panel);
        }
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
