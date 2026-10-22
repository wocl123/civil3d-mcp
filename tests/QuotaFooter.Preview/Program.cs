using System.IO;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using MyCivil3DMcp.Plugin;

internal static class Program
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-15T00:00:00Z");

    [STAThread]
    private static void Main(string[] args)
    {
        CheckFormatting();
        CheckSwitching();
        string output = Path.GetFullPath(args.FirstOrDefault() ?? "test-results/quota-footer");
        Directory.CreateDirectory(output);
        Render(output, "claude", 7, 60, TimeSpan.FromHours(34), false);
        Render(output, "codex", 11, 28, TimeSpan.FromHours(124), false);
        Render(output, "claude", 7, 60, TimeSpan.FromHours(34), true);
        Render(output, "codex", 11, 28, TimeSpan.FromHours(124), true);
        Console.WriteLine("Quota footer: usage/time parsing, expired/missing values and WPF rendering passed.");
        Console.WriteLine(output);
    }

    private static void CheckFormatting()
    {
        QuotaWindowDisplay shortWindow = new("5시간", 7, Now.AddHours(4).AddMinutes(7));
        Check(shortWindow.PercentText(Now) == "7%", "shows used percentage");
        Check(shortWindow.ResetText(Now) == "4h 7m", "short countdown");
        Check(new QuotaWindowDisplay("7일", 60, Now.AddHours(34)).ResetText(Now) == "1d 10h", "weekly countdown");
        Check(shortWindow.ResetText(Now.AddMinutes(1)) == "4h 6m", "countdown moves with time");
        Check(shortWindow.PercentText(Now.AddDays(1)) == "—", "expired percentage is not reused");
        Check(new QuotaWindowDisplay("5시간", 0, null).PercentText(Now) == "0%", "real zero remains zero");
        Check(new QuotaWindowDisplay("5시간", 0.01, null).PercentText(Now) == "<0.1%", "small percentage");
        Check(new QuotaWindowDisplay("5시간", 7, null).ResetText(Now) == "—", "unknown reset");
        Check(QuotaDisplay.Read(null).Windows.Count == 0, "missing data is not zero");
        Check(QuotaDisplay.Read(JsonNode.Parse("{\"windows\":[{\"usedPercent\":\"NaN\"}]}"))
            .Windows.Count == 0, "invalid number is not zero");
        QuotaDisplay remaining = QuotaDisplay.Read(JsonNode.Parse("{\"windows\":[{\"remainingPercent\":89}]}"));
        Check(remaining.Windows[0].UsedPercent == 11, "remaining data is converted to used");
        QuotaDisplay limited = QuotaDisplay.Read(JsonNode.Parse("{\"ordinaryUsageAllowed\":false}"));
        Check(limited.Restricted, "restriction preserved");
    }

    private static void Check(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private static void CheckSwitching()
    {
        QuotaStrip strip = new(Brushes.White, Brushes.Gray, Brushes.DarkGray, Brushes.Goldenrod, Brushes.Red);
        strip.Show("claude", new QuotaDisplay([new("5시간", 7, Now.AddHours(4))], "", false), "Claude 토큰", Now);
        strip.Show("codex", new QuotaDisplay([new("5시간", 11, Now.AddHours(4))], "", false), "Codex 토큰", Now);
        string text = VisibleText(strip);
        Check(text.Contains("11%") && !text.Contains("7%"), "provider switch clears previous percentages");
        Check(strip.ToolTip.ToString()!.Contains("Codex 토큰"), "tooltip belongs to selected provider");
        strip.Show("claude", QuotaDisplay.Failed, "", Now);
        text = VisibleText(strip);
        Check(text.Contains("조회 실패") && !text.Contains("0%"), "failed refresh never shows invented usage");
        strip.Show("codex", new QuotaDisplay([new("5시간", 23, Now.AddHours(4))], "한도 도달", true), "", Now);
        Check(VisibleText(strip).Contains("사용 제한됨"), "restriction remains visible beside percentages");
    }

    private static string VisibleText(QuotaStrip strip) => string.Join(" ", strip.Children.OfType<TextBlock>()
        .Select(line => new TextRange(line.ContentStart, line.ContentEnd).Text));

    private static void Render(
        string output, string provider, double primary, double weekly, TimeSpan reset, bool light)
    {
        Brush text = Color(light ? "#1F2329" : "#E6E9ED");
        Brush muted = Color(light ? "#6A717B" : "#9EA7B3");
        QuotaStrip strip = new(text, muted, Color(light ? "#D5D9E0" : "#4A5361"),
            Color(light ? "#B7791F" : "#E8B04B"), Color("#FF8A80"));
        strip.Show(provider, new QuotaDisplay([
            new("5시간", primary, Now.AddHours(4).AddMinutes(provider == "claude" ? 7 : 6)),
            new("7일", weekly, Now.Add(reset))
        ], "", false), "이번 1.2k · 누적 12k", Now);
        Border root = new() { Background = Color(light ? "#F3F4F6" : "#252525"),
            Padding = new Thickness(10, 5, 10, 5), Child = strip };
        Save(root, Path.Combine(output, provider + (light ? "-light" : "") + ".png"), 290, 29);
        if (provider == "codex" && !light)
        {
            Save(root, Path.Combine(output, "codex-narrow.png"), 175, 52);
        }
    }

    private static void Save(FrameworkElement element, string file, double width, double height)
    {
        element.Measure(new Size(width, height));
        element.Arrange(new Rect(0, 0, width, height));
        element.UpdateLayout();
        RenderTargetBitmap bitmap = new((int)(width * 2), (int)(height * 2), 192, 192, PixelFormats.Pbgra32);
        bitmap.Render(element);
        PngBitmapEncoder encoder = new();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using FileStream stream = File.Create(file);
        encoder.Save(stream);
    }

    private static Brush Color(string hex) => (Brush)new BrushConverter().ConvertFromString(hex)!;
}
