using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Renders the small Markdown subset the palette AI is told to use: "#" headings,
/// **bold**, `code`, "-" and "1." lists, pipe tables, and code fences.
/// Anything else is shown as plain text.
/// </summary>
internal static partial class MarkdownView
{
    private static readonly FontFamily Mono = new("Consolas");

    [GeneratedRegex(@"^#{1,6}\s+(.*)$")]
    private static partial Regex Heading();

    [GeneratedRegex(@"^(\s*)([-*+]|\d+[.)])\s+(.*)$")]
    private static partial Regex ListItem();

    [GeneratedRegex(@"^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")]
    private static partial Regex TableRule();

    [GeneratedRegex(@"\*\*(.+?)\*\*|`([^`]+)`")]
    private static partial Regex Inline();

    [GeneratedRegex(@"(?<=\d)\+(?=\d)")]
    private static partial Regex StationPlus();

    [GeneratedRegex(@"<br\s*/?>", RegexOptions.IgnoreCase)]
    private static partial Regex LineBreakTag();

    // Numbers, stations (0+120.00), and percentages read best right-aligned.
    [GeneratedRegex(@"^[+\-−]?[\d,]*\.?\d+(\s*(%|m|㎡|m²|m³))?$|^\d+\+\d+(\.\d+)?$")]
    private static partial Regex NumberCell();

    /// <param name="wheel">Receives mouse-wheel turns over a table so the chat keeps scrolling.</param>
    public static FrameworkElement Render(string markdown, ChatTheme theme, Action<MouseWheelEventArgs> wheel)
    {
        StackPanel blocks = new();
        string[] lines = Lines(markdown);
        List<string> paragraph = [];

        void Add(FrameworkElement element, double top = 6)
        {
            element.Margin = new Thickness(0, blocks.Children.Count == 0 ? 0 : top, 0, 0);
            blocks.Children.Add(element);
        }
        void FlushParagraph()
        {
            if (paragraph.Count == 0) return;
            TextBlock text = Text(theme);
            for (int i = 0; i < paragraph.Count; i++)
            {
                if (i > 0) text.Inlines.Add(new LineBreak());
                AddInlines(text, paragraph[i], theme);
            }
            Add(text);
            paragraph.Clear();
        }

        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                FlushParagraph();
                List<string> code = [];
                while (++i < lines.Length && !lines[i].TrimStart().StartsWith("```", StringComparison.Ordinal)) code.Add(lines[i]);
                Add(CodeBlock(string.Join("\n", code), theme));
                continue;
            }
            if (IsTableStart(lines, i))
            {
                FlushParagraph();
                List<string> rows = [lines[i]];
                string rule = lines[++i];
                while (i + 1 < lines.Length && lines[i + 1].TrimStart().StartsWith('|')) rows.Add(lines[++i]);
                Add(Table(rows, Alignments(rule), theme, wheel), 8);
                continue;
            }
            if (string.IsNullOrWhiteSpace(line)) { FlushParagraph(); continue; }
            Match heading = Heading().Match(line.Trim());
            if (heading.Success)
            {
                FlushParagraph();
                TextBlock text = Text(theme);
                text.FontWeight = FontWeights.SemiBold;
                text.FontSize = 13.5;
                AddInlines(text, heading.Groups[1].Value, theme);
                Add(text, 10);
                continue;
            }
            Match item = ListItem().Match(line);
            if (item.Success)
            {
                FlushParagraph();
                bool continuing = blocks.Children.Count > 0 && blocks.Children[^1] is Grid { Tag: "list" };
                Add(ListRow(item, theme), continuing ? 2 : 6);
                continue;
            }
            paragraph.Add(line.Trim());
        }
        FlushParagraph();
        return blocks;
    }

    /// <summary>Plain text for the clipboard; tables become tab-separated rows that paste into Excel.</summary>
    public static string PlainText(string markdown)
    {
        StringBuilder result = new();
        string[] lines = Lines(markdown);
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];
            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal)) continue;
            if (line.TrimStart().StartsWith('|'))
            {
                if (!TableRule().IsMatch(line.Trim())) result.AppendLine(string.Join("\t", Cells(line).Select(Strip)));
                continue;
            }
            Match heading = Heading().Match(line.Trim());
            result.AppendLine(Strip(heading.Success ? heading.Groups[1].Value : line));
        }
        return result.ToString().TrimEnd();
    }

    private static string[] Lines(string markdown) => markdown.Replace("\r\n", "\n").Trim('\n').Split('\n');

    private static string Strip(string text) => Inline().Replace(LineBreakTag().Replace(text, " "), match =>
        match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value);

    private static bool IsTableStart(string[] lines, int i) =>
        lines[i].TrimStart().StartsWith('|') && i + 1 < lines.Length && TableRule().IsMatch(lines[i + 1].Trim());

    private static List<string> Cells(string row)
    {
        string trimmed = row.Trim();
        if (trimmed.StartsWith('|')) trimmed = trimmed[1..];
        if (trimmed.EndsWith('|')) trimmed = trimmed[..^1];
        return trimmed.Split('|').Select(cell => cell.Trim()).ToList();
    }

    private static List<TextAlignment?> Alignments(string rule) => Cells(rule).Select(cell =>
        cell.EndsWith(':') ? (cell.StartsWith(':') ? TextAlignment.Center : TextAlignment.Right)
        : cell.StartsWith(':') ? TextAlignment.Left : (TextAlignment?)null).ToList();

    private static TextBlock Text(ChatTheme theme) => new() { TextWrapping = TextWrapping.Wrap, Foreground = theme.Text, LineHeight = 19 };

    private static void AddInlines(TextBlock target, string text, ChatTheme theme)
    {
        // Some AIs break a table cell with <br>; show it as a line break.
        string[] parts = LineBreakTag().Split(text);
        for (int i = 0; i < parts.Length; i++)
        {
            if (i > 0) target.Inlines.Add(new LineBreak());
            AddStyledRuns(target, parts[i], theme);
        }
    }

    private static void AddStyledRuns(TextBlock target, string text, ChatTheme theme)
    {
        // WPF may break a line after "+", which splits stations such as 0+339.21.
        text = StationPlus().Replace(text, "\u2060+\u2060");
        int at = 0;
        foreach (Match match in Inline().Matches(text))
        {
            if (match.Index > at) target.Inlines.Add(new Run(text[at..match.Index]));
            if (match.Groups[1].Success)
                target.Inlines.Add(new Run(match.Groups[1].Value) { FontWeight = FontWeights.Bold });
            else
                target.Inlines.Add(new Run(match.Groups[2].Value) { FontFamily = Mono, Background = theme.Surface });
            at = match.Index + match.Length;
        }
        if (at < text.Length) target.Inlines.Add(new Run(text[at..]));
    }

    private static Grid ListRow(Match item, ChatTheme theme)
    {
        int depth = item.Groups[1].Value.Replace("\t", "  ").Length / 2;
        string marker = item.Groups[2].Value;
        Grid row = new() { Tag = "list" };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(depth * 14 + (char.IsDigit(marker[0]) ? 20 : 14)) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        TextBlock bullet = new()
        {
            Text = char.IsDigit(marker[0]) ? marker : "•", Foreground = theme.Muted, LineHeight = 19,
            HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 0, 6, 0)
        };
        TextBlock text = Text(theme);
        AddInlines(text, item.Groups[3].Value, theme);
        Grid.SetColumn(text, 1);
        row.Children.Add(bullet);
        row.Children.Add(text);
        return row;
    }

    private static FrameworkElement Table(List<string> rows, List<TextAlignment?> alignments, ChatTheme theme,
        Action<MouseWheelEventArgs> wheel)
    {
        List<List<string>> cells = rows.Select(Cells).ToList();
        int columns = cells.Max(row => row.Count);
        Grid grid = new();
        // The first column (usually names) wraps so the table fits the panel; the others keep one line.
        for (int c = 0; c < columns; c++)
            grid.ColumnDefinitions.Add(new ColumnDefinition { Width = c == 0 ? new GridLength(1, GridUnitType.Star) : GridLength.Auto });
        for (int r = 0; r < cells.Count; r++)
        {
            grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            for (int c = 0; c < columns; c++)
            {
                string value = c < cells[r].Count ? cells[r][c] : "";
                bool header = r == 0;
                TextAlignment alignment = (c < alignments.Count ? alignments[c] : null)
                    ?? (!header && NumberCell().IsMatch(Strip(value)) ? TextAlignment.Right : TextAlignment.Left);
                TextBlock text = new()
                {
                    Foreground = theme.Text, TextAlignment = alignment, TextWrapping = c == 0 ? TextWrapping.Wrap : TextWrapping.NoWrap,
                    FontWeight = header ? FontWeights.SemiBold : FontWeights.Normal
                };
                AddInlines(text, value, theme);
                Border cell = new()
                {
                    Child = text, Padding = new Thickness(7, 3, 7, 3),
                    Background = header ? theme.Surface : Brushes.Transparent, BorderBrush = theme.Border,
                    BorderThickness = new Thickness(c == 0 ? 0 : 1, 0, 0, r == cells.Count - 1 ? 0 : 1)
                };
                Grid.SetRow(cell, r);
                Grid.SetColumn(cell, c);
                grid.Children.Add(cell);
            }
        }
        Border frame = new()
        {
            Child = grid, BorderBrush = theme.Border, BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(4), HorizontalAlignment = HorizontalAlignment.Left
        };
        // The table takes the panel width; only when even a narrow first column does
        // not fit does it scroll sideways. The wheel still scrolls the conversation.
        ScrollViewer scroller = new()
        {
            Content = frame, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled
        };
        double minimum = MinimumWidth(grid);
        scroller.SizeChanged += (_, e) =>
        {
            double width = Math.Max(e.NewSize.Width, minimum);
            if (Math.Abs(frame.Width - width) > 0.5 || double.IsNaN(frame.Width)) frame.Width = width;
        };
        scroller.PreviewMouseWheel += (_, e) => { e.Handled = true; wheel(e); };
        return scroller;
    }

    // Room for every one-line column plus a first column of about six characters, and the frame.
    private static double MinimumWidth(Grid grid)
    {
        Dictionary<int, double> widths = [];
        foreach (UIElement cell in grid.Children)
        {
            int column = Grid.GetColumn(cell);
            if (column == 0) continue;
            cell.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            widths[column] = Math.Max(widths.GetValueOrDefault(column), cell.DesiredSize.Width);
        }
        return widths.Values.Sum() + 80 + 2;
    }

    private static FrameworkElement CodeBlock(string code, ChatTheme theme) => new Border
    {
        Background = theme.Surface, CornerRadius = new CornerRadius(4), Padding = new Thickness(8, 5, 8, 5),
        Child = new TextBlock { Text = code, FontFamily = Mono, Foreground = theme.Text, TextWrapping = TextWrapping.Wrap }
    };
}
