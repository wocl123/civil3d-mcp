using System.Text;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 팔레트 AI에게 쓰라고 한 작은 Markdown만 그린다: "#" 제목, **굵게**, `코드`,
/// "-"·"1." 목록, | 표, ``` 코드 블록. 그 밖은 평범한 글로 보인다.
/// </summary>
internal static partial class MarkdownView
{
    private static readonly FontFamily Mono = new("Consolas");
    private static readonly FontFamily Body = new("Malgun Gothic");
    private const double BodySize = 12.5;
    private const double FirstColumnMinimum = 80;
    private const double MaxColumnWidth = 260;

    // 줄바꿈 없는 "+"(앞뒤에 WORD JOINER U+2060).
    private const string NoBreakPlus = "⁠+⁠";

    // ── 줄 모양 판별
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

    // 숫자, 측점(0+120.00), 백분율 칸은 오른쪽 정렬이 읽기 좋다.
    [GeneratedRegex(@"^[+\-−]?[\d,]*\.?\d+(\s*(%|m|㎡|m²|m³))?$|^\d+\+\d+(\.\d+)?$")]
    private static partial Regex NumberCell();

    /// <summary>
    /// 답 전체를 읽기 전용 서식 문서 하나로 만든다. 문단·목록·표를 넘어 드래그로 선택하고
    /// Ctrl+C로 복사할 수 있다.
    /// </summary>
    /// <param name="wheel">답 위에서 굴린 마우스 휠. 대화창이 계속 스크롤되게 넘긴다.</param>
    public static FrameworkElement Render(string markdown, ChatTheme theme, Action<MouseWheelEventArgs> wheel)
    {
        FlowDocument document = new()
        {
            PagePadding = new Thickness(0),
            FontFamily = Body,
            FontSize = BodySize,
            Foreground = theme.Text,
            LineHeight = 19,
            TextAlignment = TextAlignment.Left
        };

        string[] lines = Lines(markdown);
        List<string> paragraph = [];
        bool lastWasList = false;

        // 블록 사이 위쪽 여백(첫 블록은 0).
        void Add(Block block, double top = 6)
        {
            double margin = document.Blocks.Count == 0 ? 0 : top;
            block.Margin = new Thickness(block.Margin.Left, margin, 0, 0);
            document.Blocks.Add(block);
        }

        // 모아 둔 평범한 줄들을 문단 하나로.
        void FlushParagraph()
        {
            if (paragraph.Count == 0)
            {
                return;
            }

            Paragraph text = new();
            for (int i = 0; i < paragraph.Count; i++)
            {
                if (i > 0)
                {
                    text.Inlines.Add(new LineBreak());
                }

                AddInlines(text.Inlines, paragraph[i], theme);
            }

            Add(text);
            paragraph.Clear();
            lastWasList = false;
        }

        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i];

            // ``` 코드 블록: 닫는 ```까지
            if (IsFence(line))
            {
                FlushParagraph();

                List<string> code = [];
                while (++i < lines.Length && !IsFence(lines[i]))
                {
                    code.Add(lines[i]);
                }

                Add(CodeBlock(string.Join("\n", code), theme));
                lastWasList = false;
                continue;
            }

            // 표: 머리 줄 + 구분선 + |로 시작하는 줄들
            if (IsTableStart(lines, i))
            {
                FlushParagraph();

                List<string> rows = [lines[i]];
                string rule = lines[++i];
                while (i + 1 < lines.Length && lines[i + 1].TrimStart().StartsWith('|'))
                {
                    rows.Add(lines[++i]);
                }

                Add(Table(rows, Alignments(rule), theme), 8);
                lastWasList = false;
                continue;
            }

            // 빈 줄: 문단 끝
            if (string.IsNullOrWhiteSpace(line))
            {
                FlushParagraph();
                continue;
            }

            // # 제목
            Match heading = Heading().Match(line.Trim());
            if (heading.Success)
            {
                FlushParagraph();

                Paragraph text = new() { FontWeight = FontWeights.SemiBold, FontSize = 13.5 };
                AddInlines(text.Inlines, heading.Groups[1].Value, theme);
                Add(text, 10);
                lastWasList = false;
                continue;
            }

            // - 목록 / 1. 목록 (이어지는 목록은 간격을 좁게)
            Match item = ListItem().Match(line);
            if (item.Success)
            {
                FlushParagraph();
                Add(ListRow(item, theme), lastWasList ? 2 : 6);
                lastWasList = true;
                continue;
            }

            paragraph.Add(line.Trim());
        }

        FlushParagraph();

        RichTextBox box = new()
        {
            Document = document,
            IsReadOnly = true,
            IsReadOnlyCaretVisible = false,
            BorderThickness = new Thickness(0),
            Background = Brushes.Transparent,
            Foreground = theme.Text,
            Padding = new Thickness(0),
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            SelectionBrush = theme.Accent,
            Cursor = Cursors.IBeam
        };

        box.PreviewMouseWheel += (_, e) =>
        {
            e.Handled = true;
            wheel(e);
        };

        // FlowDocument 표는 남는 너비를 스스로 나누지 않는다. 그래서 첫 열에
        // 다른 열이 쓰고 남은 너비를 직접 준다(크기가 바뀔 때마다).
        box.SizeChanged += (_, e) =>
        {
            foreach (Table table in document.Blocks.OfType<Table>())
            {
                double others = table.Columns.Skip(1).Sum(column => column.Width.Value);
                double first = Math.Max(FirstColumnMinimum, e.NewSize.Width - others - 12);

                if (Math.Abs(table.Columns[0].Width.Value - first) > 0.5)
                {
                    table.Columns[0].Width = new GridLength(first);
                }
            }
        };

        return box;
    }

    /// <summary>클립보드용 평범한 글. 표는 탭으로 나눈 줄이 되어 Excel에 그대로 붙는다.</summary>
    public static string PlainText(string markdown)
    {
        StringBuilder result = new();

        foreach (string line in Lines(markdown))
        {
            if (IsFence(line))
            {
                continue;
            }

            if (line.TrimStart().StartsWith('|'))
            {
                if (!TableRule().IsMatch(line.Trim()))
                {
                    result.AppendLine(string.Join("\t", Cells(line).Select(Strip)));
                }

                continue;
            }

            Match heading = Heading().Match(line.Trim());
            result.AppendLine(Strip(heading.Success ? heading.Groups[1].Value : line));
        }

        return result.ToString().TrimEnd();
    }

    private static string[] Lines(string markdown) => markdown.Replace("\r\n", "\n").Trim('\n').Split('\n');

    private static bool IsFence(string line) => line.TrimStart().StartsWith("```", StringComparison.Ordinal);

    // **굵게**, `코드`, <br>를 걷어 낸 글.
    private static string Strip(string text)
    {
        string withoutBreaks = LineBreakTag().Replace(text, " ");
        return Inline().Replace(
            withoutBreaks, match => match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value);
    }

    // 표 시작: 이 줄에 |가 있고 다음 줄이 |---| 구분선.
    private static bool IsTableStart(string[] lines, int i) =>
        lines[i].TrimStart().StartsWith('|')
        && i + 1 < lines.Length
        && TableRule().IsMatch(lines[i + 1].Trim());

    private static List<string> Cells(string row)
    {
        string trimmed = row.Trim();

        if (trimmed.StartsWith('|'))
        {
            trimmed = trimmed[1..];
        }

        if (trimmed.EndsWith('|'))
        {
            trimmed = trimmed[..^1];
        }

        return trimmed.Split('|').Select(cell => cell.Trim()).ToList();
    }

    // 구분선의 :---, ---:, :---: 로 열 정렬. 표시가 없으면 null(칸 내용으로 정함).
    private static List<TextAlignment?> Alignments(string rule) => Cells(rule).Select(AlignmentOf).ToList();

    private static TextAlignment? AlignmentOf(string cell)
    {
        bool left = cell.StartsWith(':');
        bool right = cell.EndsWith(':');

        if (left && right)
        {
            return TextAlignment.Center;
        }

        if (right)
        {
            return TextAlignment.Right;
        }

        if (left)
        {
            return TextAlignment.Left;
        }

        return null;
    }

    private static void AddInlines(InlineCollection target, string text, ChatTheme theme)
    {
        // 어떤 AI는 표 칸 안에서 <br>로 줄을 바꾼다. 줄바꿈으로 보여 준다.
        string[] parts = LineBreakTag().Split(text);

        for (int i = 0; i < parts.Length; i++)
        {
            if (i > 0)
            {
                target.Add(new LineBreak());
            }

            AddStyledRuns(target, parts[i], theme);
        }
    }

    private static void AddStyledRuns(InlineCollection target, string text, ChatTheme theme)
    {
        // WPF는 "+" 뒤에서 줄을 바꿀 수 있어 0+339.21 같은 측점이 쪼개진다(→ 줄바꿈 없는 + 로).
        text = StationPlus().Replace(text, NoBreakPlus);
        int at = 0;

        foreach (Match match in Inline().Matches(text))
        {
            if (match.Index > at)
            {
                target.Add(new Run(text[at..match.Index]));
            }

            if (match.Groups[1].Success)
            {
                target.Add(new Run(match.Groups[1].Value) { FontWeight = FontWeights.Bold });
            }
            else
            {
                target.Add(new Run(match.Groups[2].Value) { FontFamily = Mono, Background = theme.Surface });
            }

            at = match.Index + match.Length;
        }

        if (at < text.Length)
        {
            target.Add(new Run(text[at..]));
        }
    }

    // 내어쓰기: 줄이 넘어가도 글머리표 아래가 아니라 글 아래에서 이어진다.
    private static Paragraph ListRow(Match item, ChatTheme theme)
    {
        int depth = item.Groups[1].Value.Replace("\t", "  ").Length / 2;
        string marker = item.Groups[2].Value;
        bool numbered = char.IsDigit(marker[0]);
        double hang = numbered ? 20 : 14;

        Paragraph row = new()
        {
            Margin = new Thickness(depth * 14 + hang, 0, 0, 0),
            TextIndent = -hang
        };

        string bullet = numbered ? marker : "•";
        row.Inlines.Add(new Run(bullet + " ") { Foreground = theme.Muted });
        AddInlines(row.Inlines, item.Groups[3].Value, theme);
        return row;
    }

    // 첫 열(보통 이름)은 남는 너비를 쓰고 줄바꿈한다. 나머지 열은 가장 긴 값만큼 넓어
    // 한 줄로 유지된다.
    private static Table Table(List<string> rows, List<TextAlignment?> alignments, ChatTheme theme)
    {
        List<List<string>> cells = rows.Select(Cells).ToList();
        int columns = cells.Max(row => row.Count);

        Table table = new()
        {
            CellSpacing = 0,
            BorderBrush = theme.Border,
            BorderThickness = new Thickness(1)
        };

        for (int column = 0; column < columns; column++)
        {
            double width = column == 0 ? FirstColumnMinimum : Math.Min(ColumnWidth(cells, column), MaxColumnWidth);
            table.Columns.Add(new TableColumn { Width = new GridLength(width) });
        }

        TableRowGroup group = new();
        for (int r = 0; r < cells.Count; r++)
        {
            bool header = r == 0;
            bool lastRow = r == cells.Count - 1;

            TableRow row = new();
            if (header)
            {
                row.Background = theme.Surface;
            }

            for (int c = 0; c < columns; c++)
            {
                string value = c < cells[r].Count ? cells[r][c] : "";

                // 구분선 정렬이 우선, 없으면 숫자 칸은 오른쪽.
                TextAlignment? ruled = c < alignments.Count ? alignments[c] : null;
                bool numeric = !header && NumberCell().IsMatch(Strip(value));
                TextAlignment alignment = ruled ?? (numeric ? TextAlignment.Right : TextAlignment.Left);

                Paragraph text = new()
                {
                    TextAlignment = alignment,
                    FontWeight = header ? FontWeights.SemiBold : FontWeights.Normal,
                    Margin = new Thickness(0)
                };
                AddInlines(text.Inlines, value, theme);

                row.Cells.Add(new TableCell(text)
                {
                    Padding = new Thickness(7, 3, 7, 3),
                    BorderBrush = theme.Border,
                    BorderThickness = new Thickness(c == 0 ? 0 : 1, 0, 0, lastRow ? 0 : 1)
                });
            }

            group.Rows.Add(row);
        }

        table.RowGroups.Add(group);
        return table;
    }

    // 열에서 가장 긴 글자 너비 + 여백(머리 줄은 굵게 잰다).
    private static double ColumnWidth(List<List<string>> cells, int column)
    {
        double widest = cells
            .Select((row, r) => column < row.Count ? TextWidth(Strip(row[column]), bold: r == 0) : 0)
            .Max();

        return widest + 16;
    }

    // 글자 너비(열 너비 계산용).
    private static double TextWidth(string text, bool bold)
    {
        Typeface typeface = new(Body, FontStyles.Normal, bold ? FontWeights.SemiBold : FontWeights.Normal,
            FontStretches.Normal);

        FormattedText formatted = new(text, System.Globalization.CultureInfo.CurrentCulture,
            FlowDirection.LeftToRight, typeface, BodySize, Brushes.Black, 1.0);

        return formatted.WidthIncludingTrailingWhitespace;
    }

    private static Paragraph CodeBlock(string code, ChatTheme theme) => new(new Run(code))
    {
        FontFamily = Mono,
        Background = theme.Surface,
        Padding = new Thickness(8, 5, 8, 5),
        LineHeight = 17
    };
}
