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
/// 대화형 AI 팔레트: 위에서부터 제목, AI 선택(로그인 상태·남은 세션 시간), 말풍선 대화,
/// 입력칸(Enter 보내기, Shift+Enter 줄바꿈), 사용량 한 줄.
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
    // 준비된 AI마다 세션이 끝나는 시각과 세션 길이(서비스가 알려 줌).
    // 쓰면 시간이 처음부터 다시 시작되고, 안 쓰면 시간이 다 됐을 때 풀린다.
    private readonly Dictionary<string, DateTime> _sessionEnds = new();
    private readonly Dictionary<string, TimeSpan> _sessionLengths = new();
    private readonly DispatcherTimer _sessionClock = new() { Interval = TimeSpan.FromSeconds(1) };
    private string? _selected;
    // 이 대화의 id. 서비스는 이 id로 최근 대화를 찾아 질문과 함께 AI에 보낸다.
    private string _conversation = Guid.NewGuid().ToString("N");
    private bool _busy;
    private bool _changing;
    private readonly List<Action> _refreshChangeButtons = new();
    // 수정안 id → 그 카드를 적용 결과로 고쳐 쓰는 함수.
    private readonly Dictionary<string, Action<JsonNode>> _cards = new();
    private string _lastUsage = "이번 —";
    private string _totalUsage = "누적 —";
    private string _quota = "한도 —";

    /// <summary>입력칸이 키보드 포커스를 얻거나 잃을 때.</summary>
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

    // 서비스가 알려 준 AI 세션의 남은 시간을 적어 둔다.
    private void ReadSession(string name, JsonNode? session)
    {
        double? left = session?["expiresInMs"]?.GetValue<double>();
        double? length = session?["sessionMs"]?.GetValue<double>();
        if (left is null) { _sessionEnds.Remove(name); return; }
        _sessionEnds[name] = DateTime.UtcNow.AddMilliseconds(left.Value);
        if (length is not null) _sessionLengths[name] = TimeSpan.FromMilliseconds(length.Value);
    }

    // 1초마다: 보이는 시간을 줄이고, 시간이 다 된 AI는 풀어 준다.
    private void TickSessions()
    {
        if (_sessionEnds.Count == 0) return;
        foreach ((string name, DateTime end) in _sessionEnds.ToList())
        {
            if (DateTime.UtcNow < end || _states[name] != "ready") continue;
            // 답을 쓰는 중이면 세션을 유지한다. 끝나면 서비스가 늘려 준다.
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

    // 남은 시간 글("29:41").
    private string SessionLeft(string name)
    {
        if (!_sessionEnds.TryGetValue(name, out DateTime end)) return "";
        TimeSpan left = end - DateTime.UtcNow;
        if (left < TimeSpan.Zero) left = TimeSpan.Zero;
        return $" · {(int)left.TotalMinutes}:{left.Seconds:00}";
    }

    // 팔레트를 열 때: AI 상태와 사용량을 새로 읽는다.
    public async Task RefreshAllAsync()
    {
        if (_busy) return;
        NodeService.Start();
        if (NodeService.LastError is not null) AddNotice(NodeService.LastError, error: true);
        await RefreshProvidersAsync();
        if (_selected is not null) await RefreshUsageAsync(_selected, refreshQuota: false);
    }

    // ── 화면 구성

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
        // 팔레트가 포커스를 잡고 있지 않으면 Civil 3D가 키 입력을 명령줄로 가져간다.
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
        _send.Click += async (_, _) =>
        {
            if (_busy)
            {
                try { await PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/chat/cancel", new { conversation = _conversation }); }
                catch (System.Exception ex) { AddNotice("중지 요청 실패: " + ex.Message, error: true); }
            }
            else await SendAsync();
        };
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

    // ── AI 고르기, 질문 보내기

    // AI 버튼을 눌렀을 때: 준비됐으면 고르고, 아니면 설치·로그인을 물어본다.
    private async Task ChooseAsync(string name)
    {
        if (_busy) return;
        // 누를 때마다 다시 확인한다. 방금 설치·로그인한 CLI도 바로 잡힌다.
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

    // 질문 보내기: 진행 상황과 답 글자를 오는 대로 보여 주고, 끝나면 사용량·적용 내역을 붙인다.
    private async Task SendAsync()
    {
        string question = _input.Text.Trim();
        if (_busy || _selected is null || question.Length == 0) return;
        string provider = _selected;
        // 질문하면 세션 시간이 처음부터 다시 시작된다(서비스도 똑같이 한다).
        if (_sessionLengths.TryGetValue(provider, out TimeSpan sessionLength)) _sessionEnds[provider] = DateTime.UtcNow + sessionLength;
        AddBubble(question, fromUser: true);
        _input.Clear();
        (Border answer, TextBlock meta, Button copy) = AddAnswer("", Display(provider));
        // AI가 일하는 동안: 무엇을 하는지와 걸린 시간, 그다음 오는 대로 답 글자.
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
        // AI가 일하는 동안 AI가 읽는 도면이 바뀌면 안 된다(DrawingGuard).
        DrawingGuard.Begin();
        try
        {
            JsonNode data = await PaletteApiClient.StreamAsync("/api/chat/stream", new { provider, message = question, conversation = _conversation }, item =>
            {
                if (item["type"]?.ToString() == "changes")
                {
                    foreach (JsonNode? change in item["applied"] as JsonArray ?? [])
                        if (change is not null) AddAppliedNote(change);
                    return;
                }
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
            string tokens = cached
                ? "저장된 답변 재사용 · 토큰 0"
                : "입력 " + Tokens(data["usage"]?["inputTokens"]) + " · 출력 " + Tokens(data["usage"]?["outputTokens"]);
            int summarized = data["conversation"]?["summarized"]?.GetValue<int>() ?? 0;
            // 답 아래 한 줄: AI · 토큰 · 걸린 시간 · 기록한 지식 · 지식 후보 · 요약한 대화
            meta.Text = $"{Display(provider)} · {tokens}"
                + (cached ? "" : $" · {clock.Elapsed.TotalSeconds:0}초")
                + (recorded > 0 ? $" · 도면 지식 {recorded}건 기록" : "")
                + (candidates > 0 ? $" · 지식 후보 {candidates}건 (/후보)" : "")
                + (summarized > 0 ? $" · 앞 대화 {summarized}개 요약됨" : "");
            _lastUsage = cached ? "이번 0" : "이번 " + Tokens(data["usage"]?["inputTokens"]);
            _totalUsage = Totals(data["totals"]);
            UpdateFooter();
            foreach (JsonNode? fix in data["fixes"] as JsonArray ?? [])
                if (fix is not null) AddChangeCard(fix, false);
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
            SetBusy(false);
            _input.Focus();
        }
    }

    // 새 대화: 화면을 비우고 새 대화 id를 쓴다.
    private void StartNewConversation()
    {
        if (_busy) return;
        string previous = _conversation;
        _conversation = Guid.NewGuid().ToString("N");
        _messages.Children.Clear();
        _refreshChangeButtons.Clear();
        _cards.Clear();
        AddNotice("새 대화를 시작합니다.");
        // 서비스는 몇 시간 뒤 옛 대화를 스스로 잊는다. 이건 조금 더 일찍 비우는 것뿐.
        _ = PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/conversation/clear", new { conversation = previous })
            .ContinueWith(_ => { }, TaskScheduler.Default);
    }

    // ── 상태 새로 읽기

    // AI마다 설치·로그인 상태와 세션.
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

    // 고른 AI의 누적 사용량과(원하면) 한도.
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

    // ── 대화 항목

    // 내 질문 말풍선.
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

    // AI 답: 표가 들어가도록 패널 너비 대부분을 쓴다. 복사 버튼은 답이 다 오면 보인다.
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
        // 다른 프로그램이 잠깐 클립보드를 잡고 있을 수 있다.
        catch (System.Runtime.InteropServices.COMException) { copy.Content = "복사 실패"; }
    }

    private void ForwardWheel(MouseWheelEventArgs e) => _scroll.ScrollToVerticalOffset(_scroll.VerticalOffset - e.Delta / 3.0);

    // 수정안과 적용 결과는 동일한 카드로 보여 준다. 버튼은 AI 비용 없이 로컬 API를 호출한다.
    private void AddAppliedNote(JsonNode change) => AddChangeCard(change, true);

    private void AddChangeCard(JsonNode change, bool applied)
    {
        string? fixId = change["fixId"]?.ToString();
        string? operationId = change["operationId"]?.ToString();
        if (fixId is null) return;
        // AI가 대화로 적용한 결과는 그 계획 카드를 고쳐 쓴다(같은 카드에 [되돌리기]·[확정]이 나타난다).
        if (_cards.TryGetValue(fixId, out Action<JsonNode>? update))
        {
            if (applied) update(change);
            return;
        }
        string state = applied ? change["state"]?.ToString() ?? "applied" : "planned";
        bool applicable = applied || change["applicable"]?.GetValue<bool>() == true;
        string conversation = _conversation;
        StackPanel body = new();
        body.Children.Add(new TextBlock { Text = change["title"]?.ToString() ?? "도면 수정안", FontWeight = FontWeights.SemiBold, Foreground = _theme.Text });
        foreach (JsonNode? label in change["labels"] as JsonArray ?? [])
            body.Children.Add(new TextBlock { Text = "• " + label, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) });
        TextBlock status = new() { Text = state == "applied" ? "도면 변경이 적용되었습니다." : state == "unknown" ? "변경 결과 확인이 필요합니다." : change["reason"]?.ToString() ?? "수정안을 확인한 뒤 적용해 주세요.", TextWrapping = TextWrapping.Wrap, Foreground = _theme.Muted, Margin = new Thickness(0, 4, 0, 4) };
        // 커밋 뒤 재검토 실패는 적용 실패가 아니다. 되돌리기 버튼은 계속 제공한다.
        if (applied && state == "applied" && change["recheck"]?["state"]?.ToString() == "failed")
            status.Text = "변경이 적용되었습니다. 재검토에 실패하여 기준 만족 여부는 확인하지 못했습니다. 취소하려면 되돌리기를 눌러 주세요.";
        body.Children.Add(status);
        // 버튼: 적용 전에는 [적용하기] (삭제 계획은 [진행]/[취소]).
        //       작업이 끝나면 [되돌리기]/[확정].
        //         [확정]: 도면은 그대로 두고 되돌리기용 작업 기록을 정리한다. 카드는 끝난다.
        //       되돌린 뒤: 값 변경은 [다시 적용]. 삭제는 버튼 없이 끝난다(다시 지우려면 새로 요청 → 새 목록 확인).
        //       같은 이름의 버튼이 상태에 따라 "확정"과 "다시 실행"을 오가면 안 된다(되돌린 삭제가 다시 실행되던 문제).
        bool deleting = change["kind"]?.ToString() == "delete";
        if (deleting && state == "planned") status.Text = "위 객체가 함께 삭제되거나 영향을 받습니다. 진행할까요?";
        if (deleting && state == "applied") status.Text = "삭제했습니다. 복원하려면 되돌리기를 눌러 주세요.";
        StackPanel buttons = new() { Orientation = Orientation.Horizontal };
        Button apply = SmallButton("", "");
        Button cancel = SmallButton("취소", "삭제하지 않습니다. 이 계획은 다시 적용되지 않습니다.");
        Button undo = SmallButton("되돌리기", "이 작업 이후 다른 편집이 없을 때 적용 취소");
        apply.Margin = cancel.Margin = undo.Margin = new Thickness(0, 0, 8, 0);
        buttons.Children.Add(undo); buttons.Children.Add(apply); buttons.Children.Add(cancel);
        body.Children.Add(buttons);
        void Refresh()
        {
            bool done = operationId is not null && state is "applied" or "undone" or "unknown";
            apply.Content = state == "applied" ? "확정" : state == "undone" ? "다시 적용" : deleting ? "진행" : "적용하기";
            apply.ToolTip = state == "applied" ? "도면은 그대로 두고 이 결과로 확정합니다. 이후에는 버튼으로 되돌릴 수 없습니다."
                : state == "undone" ? "되돌린 변경을 같은 값으로 다시 적용합니다"
                : deleting ? "위 목록대로 삭제 (Undo 한 번으로 되돌릴 수 있음)" : "이 수정안을 현재 도면에 적용";
            apply.IsEnabled = !_busy && applicable && (state is "planned" or "undone" || (state == "applied" && operationId is not null));
            // 되돌린 삭제는 끝난 카드다.
            apply.Visibility = deleting && state == "undone" ? Visibility.Collapsed : Visibility.Visible;
            cancel.IsEnabled = !_busy && state == "planned";
            undo.IsEnabled = !_busy && operationId is not null && state == "applied";
            // 되돌리기는 작업이 끝난 뒤에, 취소는 삭제 계획이 아직 적용 전일 때만 보인다. 확정하면 버튼을 모두 숨긴다.
            undo.Visibility = done ? Visibility.Visible : Visibility.Collapsed;
            cancel.Visibility = deleting && state == "planned" ? Visibility.Visible : Visibility.Collapsed;
            if (state is "confirmed" or "cancelled") apply.Visibility = undo.Visibility = cancel.Visibility = Visibility.Collapsed;
        }
        _refreshChangeButtons.Add(Refresh);
        Refresh();
        _cards[fixId] = next =>
        {
            operationId = next["operationId"]?.ToString() ?? operationId;
            state = next["state"]?.ToString() ?? "applied";
            applicable = true;
            status.Text = state == "unknown" ? "변경 결과 확인이 필요합니다."
                : deleting ? "삭제했습니다. 복원하려면 되돌리기를 눌러 주세요."
                : next["recheck"]?["state"]?.ToString() == "failed"
                    ? "변경이 적용되었습니다. 재검토에 실패하여 기준 만족 여부는 확인하지 못했습니다. 취소하려면 되돌리기를 눌러 주세요."
                    : "도면 변경이 적용되었습니다.";
            Refresh();
        };
        // [확정]: 도면은 바꾸지 않고 작업 기록만 정리한다.
        async Task Confirm()
        {
            if (_busy) return;
            SetBusy(true);
            try
            {
                JsonNode result = await PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/change/confirm", new { conversation, fixId, operationId });
                state = result["state"]?.ToString() ?? state;
                status.Text = result["message"]?.ToString() ?? "변경을 확정했습니다.";
            }
            catch (System.Exception ex) { status.Text = "확정 오류: " + ex.Message; }
            finally { SetBusy(false); Refresh(); }
        }
        async Task Run(bool reverting)
        {
            if (_busy) return;
            if (!reverting && state == "applied") { await Confirm(); return; }
            _changing = true; SetBusy(true); DrawingGuard.Begin();
            try
            {
                JsonNode result = await PaletteApiClient.RequestAsync(HttpMethod.Post,
                    reverting ? "/api/change/undo" : "/api/change/apply",
                    new { conversation, fixId, operationId });
                operationId = result["operationId"]?.ToString() ?? operationId;
                if (reverting)
                {
                    state = result["state"]?.ToString() ?? "unknown";
                    status.Text = result["message"]?.ToString() ?? "되돌리기 결과 확인이 필요합니다.";
                    if (deleting && state == "undone") status.Text += "\n다시 삭제하려면 새로 요청해 주세요. 그때의 목록을 다시 보여 드립니다.";
                }
                else
                {
                    foreach (JsonNode? next in result["fixes"] as JsonArray ?? [])
                        if (next is not null) AddChangeCard(next, false);
                    string before = state;
                    state = result["mutation"]?.ToString() ?? "unknown";
                    // 거절되면 도면은 그대로다: 누르기 전 상태(계획 또는 되돌림)로 둔다.
                    if (state == "rejected") state = before;
                    string? checkState = result["recheck"]?["state"]?.ToString();
                    string? assessment = result["recheck"]?["assessment"]?.ToString();
                    status.Text = result["applied"]?.GetValue<bool>() == true
                        ? deleting ? "삭제했습니다. 복원하려면 되돌리기를 눌러 주세요."
                        : checkState == "failed" ? "변경이 적용되었습니다. 재검토에 실패하여 기준 만족 여부는 확인하지 못했습니다. 취소하려면 되돌리기를 눌러 주세요."
                        : assessment == "pass" ? "변경이 적용되었습니다. 검토한 항목은 기준을 만족합니다."
                        : "변경이 적용되었습니다. 검토 결과: " + (assessment switch { "fail" => "기준 미달", "review" => "사람 검토 필요", "incomplete" => "검토 미완료", "not_applicable" => "검토 대상 아님", _ => "확인 필요" })
                        : result["error"]?.ToString() ?? "변경 결과 확인이 필요합니다.";
                }
            }
            catch (System.Exception ex)
            {
                status.Text = "작업 오류: " + ex.Message;
                // HTTP 응답을 잃었어도 같은 작업을 다시 실행하지 않는다. 영수증을 조회해 버튼 상태를 복원한다.
                try
                {
                    JsonNode receipt = await PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/change/status", new { conversation, fixId });
                    operationId = receipt["operationId"]?.ToString() ?? operationId;
                    state = receipt["state"]?.ToString() ?? "unknown";
                    if (state == "applied") status.Text += "\n도면에는 적용되었습니다. 취소하려면 되돌리기를 눌러 주세요.";
                    if (state == "undone") status.Text += "\n적용한 변경은 되돌려졌습니다.";
                }
                catch { state = "unknown"; status.Text += "\n변경 결과를 확인하지 못했습니다. 재적용하지 말고 도면을 확인해 주세요."; }
            }
            finally { DrawingGuard.End(); _changing = false; SetBusy(false); Refresh(); }
        }
        apply.Click += async (_, _) => await Run(false);
        undo.Click += async (_, _) => await Run(true);
        cancel.Click += async (_, _) =>
        {
            if (_busy) return;
            SetBusy(true);
            try
            {
                JsonNode result = await PaletteApiClient.RequestAsync(HttpMethod.Post, "/api/change/cancel", new { conversation, fixId });
                state = "cancelled";
                status.Text = result["message"]?.ToString() ?? "취소했습니다.";
            }
            catch (System.Exception ex) { status.Text = "취소 오류: " + ex.Message; }
            finally { SetBusy(false); Refresh(); }
        };
        _messages.Children.Add(new Border { Child = body, CornerRadius = new CornerRadius(8), Padding = new Thickness(10),
            Margin = new Thickness(0, 2, 12, 8), Background = _theme.Surface, BorderBrush = _theme.Ready, BorderThickness = new Thickness(1) });
        ScrollToEnd();
    }

    // 안내·오류 한 줄.
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

    // 설치(또는 로그인)되지 않은 AI를 고르면 먼저 묻는다. [설치]/[로그인]을 눌렀을 때만
    // 그 AI 하나에 대해 server/setup/setup-ai-cli.ps1 을 새 창으로 연다. 거기서 설치하고
    // 이어서 로그인까지 하며, 로그인은 사용자가 자기 계정으로 직접 한다.
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

    // ── 작은 부품

    // 선택할 수 있는 글(값을 도면이나 보고서로 복사할 수 있게).
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

    // 둥근 테두리만 있는 버튼 모양. 기본 Windows 버튼은 마우스를 올리거나 비활성일 때
    // 시스템 색으로 다시 칠해 테마 색이 깨진다.
    private static ControlTemplate FlatTemplate()
    {
        FrameworkElementFactory border = new(typeof(Border));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
        // 버튼의 색·테두리·여백을 그대로 테두리에 넘긴다.
        Bind(border, Border.BackgroundProperty, "Background");
        Bind(border, Border.BorderBrushProperty, "BorderBrush");
        Bind(border, Border.BorderThicknessProperty, "BorderThickness");
        Bind(border, Border.PaddingProperty, "Padding");
        FrameworkElementFactory content = new(typeof(ContentPresenter));
        Bind(content, ContentPresenter.HorizontalAlignmentProperty, "HorizontalContentAlignment");
        content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        border.AppendChild(content);
        ControlTemplate template = new(typeof(Button)) { VisualTree = border };
        // 마우스를 올리면 조금, 비활성이면 많이 흐리게.
        template.Triggers.Add(new Trigger
        {
            Property = UIElement.IsMouseOverProperty, Value = true, Setters = { new Setter(UIElement.OpacityProperty, 0.85) }
        });
        template.Triggers.Add(new Trigger
        {
            Property = UIElement.IsEnabledProperty, Value = false, Setters = { new Setter(UIElement.OpacityProperty, 0.45) }
        });
        return template;
    }

    private static void Bind(FrameworkElementFactory element, DependencyProperty property, string source) =>
        element.SetBinding(property, new System.Windows.Data.Binding(source)
        {
            RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent
        });

    // ── 화면 갱신

    // AI 버튼: 상태 점 색, 고른 것 강조, 남은 세션 시간.
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
            content.Children.Add(new Ellipse
            {
                Width = 8, Height = 8, Fill = dot, Margin = new Thickness(0, 0, 6, 0), VerticalAlignment = VerticalAlignment.Center
            });
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

    // 입력칸·보내기 버튼: AI를 골랐고 답을 기다리는 중이 아닐 때만.
    private void UpdateControls()
    {
        _placeholder.Visibility = _input.Text.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        _send.Content = _busy && !_changing ? "중지" : "보내기";
        _send.IsEnabled = !_changing && (_busy || (_selected is not null && _input.Text.Trim().Length > 0));
        foreach (Action refresh in _refreshChangeButtons) refresh();
        foreach (Button chip in _chips.Values) chip.IsEnabled = !_busy;
        _placeholder.Text = _selected is null
            ? "먼저 위에서 AI를 고르세요"
            : "도면에 대해 물어보세요 · Enter 보내기";
    }

    // 사용량 줄: 이번 · 누적 · 한도.
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

    // ── 글 만들기

    private static string Display(string name) => char.ToUpperInvariant(name[0]) + name[1..];

    private static string LoginCommand(string name) => name switch
    {
        "claude" => "claude auth login",
        "codex" => "codex login",
        _ => "gemini 실행 후 로그인"
    };

    private static string Totals(JsonNode? totals) =>
        $"누적 {totals?["requests"]?.ToString() ?? "0"}회 {Tokens(totals?["inputTokens"])}";

    // 8,412 토큰은 8.4k로(사용량 줄이 한 줄에 들어가게).
    private static string Tokens(JsonNode? value)
    {
        if (!double.TryParse(value?.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double count))
            return "—";
        return count < 1000 ? count.ToString("0", CultureInfo.InvariantCulture)
            : (count / 1000).ToString("0.#", CultureInfo.InvariantCulture) + "k";
    }
}
