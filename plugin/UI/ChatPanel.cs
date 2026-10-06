using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Chat-style AI palette: AI choices with their sign-in state, the conversation as
/// bubbles, an input box (Enter sends, Shift+Enter adds a line), and one usage line.
/// </summary>
internal sealed class ChatPanel : UserControl
{
    private static readonly string[] Providers = ["claude", "codex", "gemini"];
    private readonly ChatTheme _theme = ChatTheme.Current();
    private readonly StackPanel _messages = new() { Margin = new Thickness(10, 6, 10, 10) };
    private readonly ScrollViewer _scroll = new() { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
    private readonly TextBox _input = new();
    private readonly TextBlock _placeholder = new();
    private readonly Button _send = new() { Content = "보내기" };
    private readonly TextBlock _usage = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Dictionary<string, Button> _chips = new();
    private readonly Dictionary<string, string> _states = Providers.ToDictionary(name => name, _ => "unchecked");
    // Each ready AI's session: when it ends and how long one lasts (from the service). Using
    // the AI starts the time again; an unused AI is released when its time runs out.
    private readonly Dictionary<string, DateTime> _sessionEnds = new();
    private readonly Dictionary<string, TimeSpan> _sessionLengths = new();
    private readonly DispatcherTimer _sessionClock = new() { Interval = TimeSpan.FromSeconds(1) };
    private string? _selected;
    // Identifies this conversation to the service, which sends its recent turns with each question.
    private string _conversation = Guid.NewGuid().ToString("N");
    private bool _busy;
    private string _lastUsage = "이번 —";
    private string _totalUsage = "누적 —";
    private string _quota = "한도 —";

    /// <summary>Raised when the input box gains or loses keyboard focus.</summary>
    public event Action<bool>? InputFocusChanged;

    public ChatPanel()
    {
        FontFamily = new FontFamily("Malgun Gothic");
        FontSize = 12.5;
        Foreground = _theme.Text;
        Background = _theme.Background;

        Grid layout = new();
        foreach (GridLength height in new[] { GridLength.Auto, GridLength.Auto, new GridLength(1, GridUnitType.Star), GridLength.Auto, GridLength.Auto })
            layout.RowDefinitions.Add(new RowDefinition { Height = height });
        Content = layout;

        Add(layout, Header(), 0);
        Add(layout, ProviderRow(), 1);
        _scroll.Content = _messages;
        Add(layout, _scroll, 2);
        Add(layout, InputRow(), 3);
        Add(layout, Footer(), 4);

        AddNotice("AI를 고른 뒤 열린 도면에 대해 물어보세요. 도면은 수정안에 동의할 때만 바뀌며 Ctrl+Z로 되돌릴 수 있습니다.");
        UpdateControls();
        _sessionClock.Tick += (_, _) => TickSessions();
        _sessionClock.Start();
    }

    // Records the time left that the service reported for an AI's session.
    private void ReadSession(string name, JsonNode? session)
    {
        double? left = session?["expiresInMs"]?.GetValue<double>();
        double? length = session?["sessionMs"]?.GetValue<double>();
        if (left is null) { _sessionEnds.Remove(name); return; }
        _sessionEnds[name] = DateTime.UtcNow.AddMilliseconds(left.Value);
        if (length is not null) _sessionLengths[name] = TimeSpan.FromMilliseconds(length.Value);
    }

    // Every second: count down the shown time, and release an AI whose time ran out.
    private void TickSessions()
    {
        if (_sessionEnds.Count == 0) return;
        foreach ((string name, DateTime end) in _sessionEnds.ToList())
        {
            if (DateTime.UtcNow < end || _states[name] != "ready") continue;
            // The answer being written keeps the session alive; the service extends it when done.
            if (_busy && name == _selected) continue;
            _sessionEnds.Remove(name);
            _states[name] = "unchecked";
            if (name == _selected)
            {
                _selected = null;
                int minutes = (int)Math.Round((_sessionLengths.TryGetValue(name, out TimeSpan length) ? length : TimeSpan.FromMinutes(30)).TotalMinutes);
                AddNotice($"{Display(name)}를 {minutes}분 동안 쓰지 않아 세션이 풀렸습니다. 다시 누르면 로그인을 확인하고 이어서 씁니다.");
                UpdateControls();
            }
        }
        UpdateChips();
    }

    private string SessionLeft(string name)
    {
        if (!_sessionEnds.TryGetValue(name, out DateTime end)) return "";
        TimeSpan left = end - DateTime.UtcNow;
        if (left < TimeSpan.Zero) left = TimeSpan.Zero;
        return $" · {(int)left.TotalMinutes}:{left.Seconds:00}";
    }

    public async Task RefreshAllAsync()
    {
        if (_busy) return;
        NodeService.Start();
        if (NodeService.LastError is not null) AddNotice(NodeService.LastError, error: true);
        await RefreshProvidersAsync();
        if (_selected is not null) await RefreshUsageAsync(_selected, refreshQuota: false);
    }

    private UIElement Header()
    {
        DockPanel header = new() { Margin = new Thickness(12, 10, 10, 4), LastChildFill = true };
        Button clear = SmallButton("새 대화", "대화를 지우고 새로 시작합니다. AI는 앞의 대화를 잊고, 도면 지식과 저장된 답변은 그대로입니다.");
        clear.Click += (_, _) => StartNewConversation();
        DockPanel.SetDock(clear, Dock.Right);
        header.Children.Add(clear);
        header.Children.Add(new TextBlock
        {
            Text = "My Civil 3D AI", FontSize = 14, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center
        });
        return header;
    }

    private UIElement ProviderRow()
    {
        UniformGrid row = new() { Rows = 1, Margin = new Thickness(10, 2, 10, 6) };
        foreach (string name in Providers)
        {
            Button chip = new()
            {
                Margin = new Thickness(2), Padding = new Thickness(6, 5, 6, 5), Cursor = Cursors.Hand,
                HorizontalContentAlignment = HorizontalAlignment.Left, BorderThickness = new Thickness(1.5)
            };
            chip.Template = FlatTemplate();
            chip.Click += async (_, _) => await ChooseAsync(name);
            _chips[name] = chip;
            row.Children.Add(chip);
        }
        UpdateChips();
        return row;
    }

    private UIElement InputRow()
    {
        Grid row = new() { Margin = new Thickness(10, 4, 10, 6) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        _input.AcceptsReturn = true;
        _input.TextWrapping = TextWrapping.Wrap;
        _input.MinHeight = 38;
        _input.ToolTip = "Enter 보내기 · Shift+Enter 줄바꿈 · /compact 대화 요약 · /후보 지식 후보 검토";
        _input.MaxHeight = 120;
        _input.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        _input.Padding = new Thickness(6, 6, 6, 6);
        _input.Background = _theme.Surface;
        _input.Foreground = _theme.Text;
        _input.CaretBrush = _theme.Text;
        _input.BorderBrush = _theme.Border;
        _input.PreviewKeyDown += async (_, e) =>
        {
            if (e.Key != Key.Enter || Keyboard.Modifiers.HasFlag(ModifierKeys.Shift)) return;
            e.Handled = true;
            await SendAsync();
        };
        _input.TextChanged += (_, _) => UpdateControls();
        // Civil 3D returns keystrokes to the command line unless the palette keeps focus.
        _input.GotKeyboardFocus += (_, _) => InputFocusChanged?.Invoke(true);
        _input.LostKeyboardFocus += (_, _) => InputFocusChanged?.Invoke(false);

        _placeholder.Foreground = _theme.Muted;
        _placeholder.Margin = new Thickness(9, 8, 6, 0);
        _placeholder.IsHitTestVisible = false;
        _placeholder.TextTrimming = TextTrimming.CharacterEllipsis;

        Grid inputHost = new();
        inputHost.Children.Add(_input);
        inputHost.Children.Add(_placeholder);
        Grid.SetColumn(inputHost, 0);
        row.Children.Add(inputHost);

        _send.Margin = new Thickness(6, 0, 0, 0);
        _send.Padding = new Thickness(12, 6, 12, 6);
        _send.VerticalAlignment = VerticalAlignment.Bottom;
        _send.Background = _theme.Accent;
        _send.Foreground = _theme.OnAccent;
        _send.BorderThickness = new Thickness(0);
        _send.Template = FlatTemplate();
        _send.Click += async (_, _) => await SendAsync();
        Grid.SetColumn(_send, 1);
        row.Children.Add(_send);
        return row;
    }

    private UIElement Footer()
    {
        DockPanel footer = new() { Margin = new Thickness(12, 0, 10, 8) };
        Button refresh = SmallButton("↻", "계정 사용 한도를 새로 읽습니다.");
        refresh.Click += async (_, _) => { if (_selected is not null) await RefreshUsageAsync(_selected, refreshQuota: true); };
        DockPanel.SetDock(refresh, Dock.Right);
        footer.Children.Add(refresh);
        _usage.Foreground = _theme.Muted;
        _usage.FontSize = 11.5;
        _usage.VerticalAlignment = VerticalAlignment.Center;
        footer.Children.Add(_usage);
        UpdateFooter();
        return footer;
    }

    private async Task ChooseAsync(string name)
    {
        if (_busy) return;
        // Every click checks again, so a CLI installed or signed in a moment ago is picked up.
        if (_states[name] != "ready")
        {
            SetBusy(true);
            try
            {
                JsonNode data = await PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/provider/check", new { provider = name });
                _states[name] = data["state"]?.ToString() ?? "unauthenticated";
                ReadSession(name, data["session"]);
            }
            catch (System.Exception ex) { AddNotice("인증 확인 실패: " + ex.Message, error: true); }
            finally { SetBusy(false); }
            if (_states[name] == "missing")
            {
                AskSetup(name, "install",
                    $"{Display(name)}가 이 PC에 설치되어 있지 않습니다. 설치할까요?\n설치 창이 열리고, 설치가 끝나면 로그인까지 이어 갑니다.");
                UpdateChips();
                return;
            }
            if (_states[name] != "ready")
            {
                AskSetup(name, "login",
                    $"{Display(name)} 로그인이 확인되지 않았습니다. 로그인할까요?\n로그인 창이 열리고 브라우저에서 계정으로 로그인합니다. (터미널에서 {LoginCommand(name)}를 직접 실행해도 됩니다.)");
                UpdateChips();
                return;
            }
        }
        _selected = name;
        UpdateChips();
        UpdateControls();
        await RefreshUsageAsync(name, refreshQuota: false);
        _input.Focus();
    }

    private async Task SendAsync()
    {
        string question = _input.Text.Trim();
        if (_busy || _selected is null || question.Length == 0) return;
        string provider = _selected;
        // Asking starts the session time again (the service does the same).
        if (_sessionLengths.TryGetValue(provider, out TimeSpan sessionLength)) _sessionEnds[provider] = DateTime.UtcNow + sessionLength;
        AddBubble(question, fromUser: true);
        _input.Clear();
        (Border answer, TextBlock meta, Button copy) = AddAnswer("", Display(provider));
        // While the AI works: what it is doing and for how long, then the answer text as it arrives.
        TextBlock status = new() { Foreground = _theme.Muted, FontSize = 11.5 };
        TextBox draft = SelectableText("", _theme.Text);
        draft.Visibility = Visibility.Collapsed;
        answer.Child = new StackPanel { Children = { status, draft } };
        string step = "생각하는 중";
        Stopwatch clock = Stopwatch.StartNew();
        void ShowStatus() => status.Text = $"{step} · {clock.Elapsed.TotalSeconds:0}초 · 답변 중에는 도면 편집이 잠깁니다";
        DispatcherTimer ticker = new() { Interval = TimeSpan.FromSeconds(1) };
        ticker.Tick += (_, _) => ShowStatus();
        ShowStatus();
        ticker.Start();
        SetBusy(true);
        // While the AI works, the drawing it reads must not change under it (DrawingGuard).
        DrawingGuard.Begin();
        try
        {
            JsonNode data = await PaletteApiClient.StreamAsync("/api/chat/stream", new { provider, message = question, conversation = _conversation }, item =>
            {
                string? text = item["text"]?.ToString();
                if (text is null) return;
                if (item["type"]?.ToString() == "progress") step = text;
                else
                {
                    step = "답변 쓰는 중";
                    draft.Visibility = Visibility.Visible;
                    draft.AppendText(text);
                    ScrollToEnd();
                }
                ShowStatus();
            });
            ticker.Stop();
            ReadSession(provider, data["session"]);
            string text = data["answer"]?.ToString() ?? "답변이 없습니다.";
            answer.Child = MarkdownView.Render(text, _theme, ForwardWheel);
            copy.Tag = text;
            copy.Visibility = Visibility.Visible;
            bool cached = data["cached"]?.GetValue<bool>() == true;
            int recorded = (data["recorded"] as JsonArray)?.Count ?? 0;
            int candidates = (data["candidates"] as JsonArray)?.Count ?? 0;
            string tokens = cached ? "저장된 답변 재사용 · 토큰 0" : "입력 " + Tokens(data["usage"]?["inputTokens"]) + " · 출력 " + Tokens(data["usage"]?["outputTokens"]);
            int summarized = data["conversation"]?["summarized"]?.GetValue<int>() ?? 0;
            meta.Text = $"{Display(provider)} · {tokens}" + (cached ? "" : $" · {clock.Elapsed.TotalSeconds:0}초") +
                (recorded > 0 ? $" · 도면 지식 {recorded}건 기록" : "") + (candidates > 0 ? $" · 지식 후보 {candidates}건 (/후보)" : "") + (summarized > 0 ? $" · 앞 대화 {summarized}개 요약됨" : "");
            _lastUsage = cached ? "이번 0" : "이번 " + Tokens(data["usage"]?["inputTokens"]);
            _totalUsage = Totals(data["totals"]);
            UpdateFooter();
            foreach (JsonNode? change in data["applied"] as JsonArray ?? [])
                if (change is not null) AddAppliedNote(change);
            if (!cached) _ = RefreshUsageAsync(provider, refreshQuota: true);
        }
        catch (System.Exception ex)
        {
            ticker.Stop();
            answer.Child = SelectableText("오류: " + ex.Message, _theme.Error);
            await RefreshProvidersAsync();
        }
        finally
        {
            DrawingGuard.End();
            // The requests made for this answer dropped the user's grips; show them again.
            DrawingSelection.RestoreGrips();
            SetBusy(false);
            _input.Focus();
        }
    }

    private void StartNewConversation()
    {
        if (_busy) return;
        string previous = _conversation;
        _conversation = Guid.NewGuid().ToString("N");
        _messages.Children.Clear();
        AddNotice("새 대화를 시작합니다.");
        // The service forgets the old turns on its own after a few hours; this only frees them sooner.
        _ = PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/conversation/clear", new { conversation = previous })
            .ContinueWith(_ => { }, TaskScheduler.Default);
    }

    private async Task RefreshProvidersAsync()
    {
        try
        {
            JsonNode data = await PaletteApiClient.RequestAsync(HttpMethod.Get, "/api/providers");
            foreach (JsonNode? item in data["providers"]?.AsArray() ?? [])
                if (item?["provider"]?.ToString() is { } name && _states.ContainsKey(name))
                {
                    _states[name] = item["state"]?.ToString() ?? "unchecked";
                    ReadSession(name, item["session"]);
                }
        }
        catch (System.Exception ex) { AddNotice("AI 상태 확인 실패: " + ex.Message, error: true); }
        if (_selected is not null && _states[_selected] != "ready") _selected = null;
        _selected ??= Providers.FirstOrDefault(name => _states[name] == "ready");
        UpdateChips();
        UpdateControls();
    }

    private async Task RefreshUsageAsync(string provider, bool refreshQuota)
    {
        try
        {
            JsonNode usage = await PaletteApiClient.RequestAsync(HttpMethod.Get, "/api/usage?provider=" + provider);
            if (_selected == provider) _totalUsage = Totals(usage["totals"]);
            UpdateFooter();
            JsonNode data = await PaletteApiClient.RequestAsync(HttpMethod.Get,
                "/api/quota?provider=" + provider + (refreshQuota ? "&refresh=1" : ""));
            if (_selected != provider) return;
            JsonNode? quota = data["quota"];
            if (quota?["status"]?.ToString() != "available")
                _quota = "한도 정보 없음";
            else
            {
                IEnumerable<string> windows = (quota["windows"]?.AsArray() ?? []).Select(window =>
                    $"{window?["label"]} {window?["remainingPercent"]}%");
                _quota = (quota["ordinaryUsageAllowed"]?.ToString() == "false" ? "사용 차단됨 · " : "") +
                    "남은 한도 " + string.Join(" · ", windows);
            }
        }
        catch (System.Exception) { _quota = "한도 조회 실패"; }
        UpdateFooter();
    }

    private void AddBubble(string text, bool fromUser)
    {
        Border bubble = new()
        {
            CornerRadius = new CornerRadius(10), Padding = new Thickness(10, 6, 10, 7),
            Margin = fromUser ? new Thickness(48, 6, 0, 2) : new Thickness(0, 6, 48, 2),
            HorizontalAlignment = fromUser ? HorizontalAlignment.Right : HorizontalAlignment.Left,
            Background = fromUser ? _theme.UserBubble : _theme.AssistantBubble,
            BorderBrush = _theme.Border, BorderThickness = fromUser ? new Thickness(0) : new Thickness(1),
            Child = SelectableText(text, fromUser ? _theme.OnAccent : _theme.Text)
        };
        _messages.Children.Add(bubble);
        ScrollToEnd();
    }

    // Answers get most of the panel width so tables fit; the copy button appears once the answer arrives.
    private (Border Answer, TextBlock Meta, Button Copy) AddAnswer(string text, string meta)
    {
        Border bubble = new()
        {
            CornerRadius = new CornerRadius(10), Padding = new Thickness(10, 7, 10, 8),
            Margin = new Thickness(0, 6, 12, 2), HorizontalAlignment = HorizontalAlignment.Left,
            Background = _theme.AssistantBubble, BorderBrush = _theme.Border, BorderThickness = new Thickness(1),
            Child = SelectableText(text, _theme.Muted)
        };
        _messages.Children.Add(bubble);
        Button copy = new()
        {
            Content = "복사", ToolTip = "답변을 복사합니다. 표는 엑셀에 붙여 넣을 수 있는 형태로 복사됩니다.",
            FontSize = 11, Padding = new Thickness(6, 0, 6, 1), Cursor = Cursors.Hand, Visibility = Visibility.Collapsed,
            Background = Brushes.Transparent, Foreground = _theme.Muted, BorderBrush = _theme.Border,
            BorderThickness = new Thickness(1), Template = FlatTemplate(), Margin = new Thickness(8, 0, 0, 0)
        };
        copy.Click += (_, _) => CopyAnswer(copy);
        TextBlock line = new() { Text = meta, Foreground = _theme.Muted, FontSize = 11, VerticalAlignment = VerticalAlignment.Center };
        StackPanel footer = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(4, 0, 0, 4) };
        footer.Children.Add(line);
        footer.Children.Add(copy);
        _messages.Children.Add(footer);
        ScrollToEnd();
        return (bubble, line, copy);
    }

    private static void CopyAnswer(Button copy)
    {
        if (copy.Tag is not string text) return;
        try
        {
            Clipboard.SetText(MarkdownView.PlainText(text));
            copy.Content = "복사됨";
        }
        // Another program can hold the clipboard for a moment.
        catch (System.Runtime.InteropServices.COMException) { copy.Content = "복사 실패"; }
    }

    private void ForwardWheel(MouseWheelEventArgs e) => _scroll.ScrollToVerticalOffset(_scroll.VerticalOffset - e.Delta / 3.0);

    // The AI changed the drawing in this answer: what changed, and how to undo it.
    private void AddAppliedNote(JsonNode change)
    {
        StackPanel body = new();
        body.Children.Add(new TextBlock { Text = "도면 수정 적용됨", FontWeight = FontWeights.SemiBold, Foreground = _theme.Ready });
        foreach (JsonNode? label in change["labels"] as JsonArray ?? [])
            body.Children.Add(new TextBlock { Text = "• " + label, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) });
        body.Children.Add(new TextBlock
        {
            Text = "되돌리려면 도면에서 Ctrl+Z 한 번(또는 UNDO 1)", Foreground = _theme.Muted, FontSize = 11.5, Margin = new Thickness(0, 3, 0, 0)
        });
        _messages.Children.Add(new Border
        {
            Child = body, CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 6, 10, 7),
            Margin = new Thickness(0, 2, 12, 8), HorizontalAlignment = HorizontalAlignment.Left,
            Background = _theme.Surface, BorderBrush = _theme.Ready, BorderThickness = new Thickness(1)
        });
        ScrollToEnd();
    }

    private void AddNotice(string text, bool error = false)
    {
        _messages.Children.Add(new TextBlock
        {
            Text = text, TextWrapping = TextWrapping.Wrap, FontSize = 11.5, Margin = new Thickness(4, 6, 4, 6),
            Foreground = error ? _theme.Error : _theme.Muted, HorizontalAlignment = HorizontalAlignment.Center,
            TextAlignment = TextAlignment.Center
        });
        ScrollToEnd();
    }

    // Picking an AI that is not installed (or not signed in) asks first. Only [설치] / [로그인]
    // opens server/setup/setup-ai-cli.ps1 for that one AI in its own window, where it installs
    // and goes on to the sign-in; the user signs in there with their own account.
    private void AskSetup(string name, string action, string text)
    {
        StackPanel body = new();
        body.Children.Add(new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, FontSize = 12 });
        Button yes = SmallButton(action == "install" ? "설치" : "로그인", "PowerShell 창이 열립니다.");
        Button no = SmallButton("취소", "아무것도 하지 않습니다.");
        yes.Background = _theme.Accent;
        yes.Foreground = Brushes.White;
        no.Margin = new Thickness(6, 0, 0, 0);
        StackPanel buttons = new() { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 7, 0, 0) };
        buttons.Children.Add(yes);
        buttons.Children.Add(no);
        body.Children.Add(buttons);
        yes.Click += async (_, _) =>
        {
            yes.IsEnabled = no.IsEnabled = false;
            try
            {
                JsonNode data = await PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/provider/setup", new { provider = name, action });
                AddNotice(data["message"]?.ToString() ?? "창을 열었습니다.", error: data["opened"]?.GetValue<bool>() != true);
            }
            catch (System.Exception ex)
            {
                AddNotice("창을 열지 못했습니다: " + ex.Message, error: true);
                yes.IsEnabled = no.IsEnabled = true;
            }
        };
        no.Click += (_, _) =>
        {
            yes.IsEnabled = no.IsEnabled = false;
            AddNotice($"{Display(name)} {(action == "install" ? "설치" : "로그인")}를 취소했습니다. 다시 누르면 다시 묻습니다.");
        };
        _messages.Children.Add(new Border
        {
            Child = body, CornerRadius = new CornerRadius(8), Padding = new Thickness(10, 7, 10, 8),
            Margin = new Thickness(0, 2, 12, 8), HorizontalAlignment = HorizontalAlignment.Left,
            Background = _theme.Surface, BorderBrush = _theme.Attention, BorderThickness = new Thickness(1)
        });
        ScrollToEnd();
    }

    // Answers stay selectable so values can be copied into the drawing or a report.
    private static TextBox SelectableText(string text, Brush foreground) => new()
    {
        Text = text, IsReadOnly = true, TextWrapping = TextWrapping.Wrap, BorderThickness = new Thickness(0),
        Background = Brushes.Transparent, Foreground = foreground, Padding = new Thickness(0)
    };

    private Button SmallButton(string text, string tooltip) => new()
    {
        Content = text, ToolTip = tooltip, Padding = new Thickness(8, 2, 8, 2), FontSize = 11.5,
        Background = _theme.Surface, Foreground = _theme.Text, BorderBrush = _theme.Border, Cursor = Cursors.Hand,
        BorderThickness = new Thickness(1), Template = FlatTemplate()
    };

    // A plain rounded border keeps the theme colors; the default Windows button
    // chrome would repaint hover and disabled states in system colors.
    private static ControlTemplate FlatTemplate()
    {
        FrameworkElementFactory border = new(typeof(Border));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
        border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        border.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        border.SetBinding(Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        border.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        FrameworkElementFactory content = new(typeof(ContentPresenter));
        content.SetBinding(ContentPresenter.HorizontalAlignmentProperty, new System.Windows.Data.Binding("HorizontalContentAlignment") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
        content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(content);
        ControlTemplate template = new(typeof(Button)) { VisualTree = border };
        template.Triggers.Add(new Trigger { Property = UIElement.IsMouseOverProperty, Value = true, Setters = { new Setter(UIElement.OpacityProperty, 0.85) } });
        template.Triggers.Add(new Trigger { Property = UIElement.IsEnabledProperty, Value = false, Setters = { new Setter(UIElement.OpacityProperty, 0.45) } });
        return template;
    }

    private void UpdateChips()
    {
        foreach ((string name, Button chip) in _chips)
        {
            string state = _states[name];
            bool selected = name == _selected;
            Brush dot = state switch
            {
                "ready" => _theme.Ready,
                "missing" => _theme.Unavailable,
                "unauthenticated" => _theme.Error,
                _ => _theme.Attention
            };
            StackPanel content = new() { Orientation = Orientation.Horizontal };
            content.Children.Add(new Ellipse { Width = 8, Height = 8, Fill = dot, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center });
            StackPanel label = new();
            label.Children.Add(new TextBlock { Text = Display(name), FontWeight = selected ? FontWeights.SemiBold : FontWeights.Normal });
            label.Children.Add(new TextBlock
            {
                FontSize = 10.5, Foreground = selected ? _theme.Text : _theme.Muted,
                Text = state switch
                {
                    "ready" => (selected ? "사용 중" : "사용 가능") + SessionLeft(name),
                    "missing" => "미설치",
                    "unauthenticated" => "인증 실패",
                    _ => "눌러서 확인"
                }
            });
            content.Children.Add(label);
            chip.Content = content;
            chip.Background = selected ? _theme.AssistantBubble : _theme.Surface;
            chip.BorderBrush = selected ? _theme.Accent : _theme.Border;
            chip.Foreground = _theme.Text;
            chip.ToolTip = state switch
            {
                "unauthenticated" => "누르면 다시 확인하고, 안 되면 로그인할지 묻습니다.",
                "missing" => "누르면 다시 확인하고, 없으면 설치할지 묻습니다.",
                "ready" when _sessionLengths.TryGetValue(name, out TimeSpan length) =>
                    $"남은 세션 시간입니다. 질문할 때마다 {(int)length.TotalMinutes}분으로 다시 늘어나고, 쓰지 않으면 끝날 때 풀립니다.",
                _ => null
            };
        }
    }

    private void UpdateControls()
    {
        _placeholder.Visibility = _input.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        _send.IsEnabled = !_busy && _selected is not null && _input.Text.Trim().Length > 0;
        foreach (Button chip in _chips.Values) chip.IsEnabled = !_busy;
        _placeholder.Text = _selected is null
            ? "먼저 위에서 AI를 고르세요"
            : "도면에 대해 물어보세요 · Enter 보내기";
    }

    private void UpdateFooter() => _usage.Text = _selected is null
        ? "AI를 고르면 사용량과 한도가 표시됩니다."
        : $"{_lastUsage} · {_totalUsage} · {_quota}";

    private void SetBusy(bool busy)
    {
        _busy = busy;
        UpdateControls();
    }

    private void ScrollToEnd() =>
        Dispatcher.BeginInvoke(() => _scroll.ScrollToEnd(), System.Windows.Threading.DispatcherPriority.Background);

    private static void Add(Grid grid, UIElement element, int row)
    {
        Grid.SetRow(element, row);
        grid.Children.Add(element);
    }

    private static string Display(string name) => char.ToUpperInvariant(name[0]) + name[1..];

    private static string LoginCommand(string name) => name switch
    {
        "claude" => "claude auth login",
        "codex" => "codex login",
        _ => "gemini 실행 후 로그인"
    };

    private static string Totals(JsonNode? totals) =>
        $"누적 {totals?["requests"]?.ToString() ?? "0"}회 {Tokens(totals?["inputTokens"])}";

    // 8,412 tokens read as 8.4k so the usage line stays on one line.
    private static string Tokens(JsonNode? value)
    {
        if (!double.TryParse(value?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double count))
            return "—";
        return count < 1000 ? count.ToString("0", CultureInfo.InvariantCulture)
            : (count / 1000).ToString("0.#", CultureInfo.InvariantCulture) + "k";
    }
}
