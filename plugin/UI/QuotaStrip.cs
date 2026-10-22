using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;

namespace MyCivil3DMcp.Plugin;

// 아래 사용량 줄: AI 아이콘 / 단기 사용률 막대 / 사용률과 재설정까지 남은 시간.
internal sealed class QuotaStrip(Brush text, Brush muted, Brush track, Brush warning, Brush error) : WrapPanel
{
    public void Show(string? provider, QuotaDisplay? quota, string tokens, DateTimeOffset now)
    {
        Children.Clear();
        Orientation = Orientation.Horizontal;
        VerticalAlignment = VerticalAlignment.Center;
        ToolTip = tokens;
        if (provider is null)
        {
            Children.Add(Line("AI를 고르면 사용량과 한도가 표시됩니다.", muted));
            return;
        }

        QuotaDisplay display = quota ?? QuotaDisplay.Loading;
        StackPanel header = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 1, 7, 2) };
        header.Children.Add(ProviderIcon.Create(provider, text));
        header.Children.Add(UsageBar(display.Windows.FirstOrDefault(), now));
        Children.Add(header);
        if (display.Windows.Count == 0)
        {
            string message = display.Restricted ? "사용 제한됨" : "한도 정보 없음";
            if (display == QuotaDisplay.Loading || display == QuotaDisplay.Failed)
            {
                message = display.Message;
            }

            Children.Add(Line(message, display.Restricted ? error : muted));
        }

        AddWindows(provider, display, now);
        if (display.Restricted && display.Windows.Count > 0)
        {
            Children.Add(Line(" · 사용 제한됨", error));
        }

        string details = string.Join("\n", display.Windows.Select(window => window.Detail(now)));
        ToolTip = string.Join("\n", new[] { tokens, display.Message, details }.Where(value => value.Length > 0));
    }

    private void AddWindows(string provider, QuotaDisplay display, DateTimeOffset now)
    {
        foreach (QuotaWindowDisplay window in display.Windows)
        {
            Brush color = window.Expired(now) ? muted : window.UsedPercent >= 90 ? error : warning;
            TextBlock line = Line("", text);
            if (Children.Count > 1)
            {
                line.Inlines.Add(new Run(" · ") { Foreground = muted });
            }

            line.Inlines.Add(new Run(window.PercentText(now))
            {
                Foreground = color, FontWeight = FontWeights.SemiBold
            });
            line.Inlines.Add(new Run(" " + window.ResetText(now)));
            line.ToolTip = window.Detail(now);
            AutomationProperties.SetName(line, provider + " " + window.Detail(now));
            Children.Add(line);
        }
    }

    private UIElement UsageBar(QuotaWindowDisplay? primary, DateTimeOffset now)
    {
        bool known = primary is not null && !primary.Expired(now);
        double used = known ? primary!.UsedPercent : 0;
        Border fill = new() { Background = used >= 90 ? error : muted, CornerRadius = new CornerRadius(3),
            Width = 44 * used / 100, Height = 5, HorizontalAlignment = HorizontalAlignment.Left };
        Grid rail = new() { Width = 44, Height = 5, ClipToBounds = true };
        rail.Children.Add(new Border { Background = track, CornerRadius = new CornerRadius(3), Opacity = 0.6 });
        rail.Children.Add(fill);
        return new Border
        {
            Child = rail, Margin = new Thickness(7, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center,
            ToolTip = primary?.Detail(now) ?? "사용량 정보 없음"
        };
    }

    private static TextBlock Line(string value, Brush foreground) => new()
    {
        Text = value, Foreground = foreground, FontFamily = new FontFamily("Segoe UI"), FontSize = 11.5,
        VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 0, 1)
    };
}
