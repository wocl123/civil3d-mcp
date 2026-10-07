using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;

namespace MyCivil3DMcp.Plugin;

// 팔레트 → Node 로컬 서비스 HTTP 호출. 브리지와 같은 세션 토큰으로 인증한다.
// 포트는 48900 (MY_CIVIL3D_SERVICE_PORT 로 바꿀 수 있음). 긴 답을 기다리도록 4분 제한.
// 서비스에 연결이 안 되면(꺼져 있음) 서비스를 띄우고 한 번 더 보낸다.
// 연결 자체가 거부된 경우만 다시 보내므로, 같은 요청이 서비스에서 두 번 실행되지 않는다.
internal static class PaletteApiClient
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(4) };

    private static HttpRequestMessage Request(HttpMethod method, string path, object? body)
    {
        string token = PluginBridge.SessionToken ?? throw new InvalidOperationException("Civil 3D 플러그인 연결이 없습니다.");
        HttpRequestMessage request = new(method, $"http://127.0.0.1:{NodeService.Port}{path}");
        request.Headers.Add("X-My-Civil3D-Token", token);
        if (body is not null)
            request.Content = new StringContent(System.Text.Json.JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return request;
    }

    private static async Task<HttpResponseMessage> SendAsync(HttpMethod method, string path, object? body, HttpCompletionOption completion)
    {
        try
        {
            using HttpRequestMessage request = Request(method, path, body);
            return await Http.SendAsync(request, completion);
        }
        catch (HttpRequestException ex) when (ex.InnerException is System.Net.Sockets.SocketException { SocketErrorCode: System.Net.Sockets.SocketError.ConnectionRefused })
        {
            if (!await NodeService.EnsureReadyAsync(TimeSpan.FromSeconds(15)))
                throw new InvalidOperationException("로컬 서비스에 연결할 수 없습니다. " + (NodeService.LastError ?? "Civil 3D를 다시 시작해 주세요."));
            using HttpRequestMessage retry = Request(method, path, body);
            return await Http.SendAsync(retry, completion);
        }
    }

    /// <summary>
    /// 한 줄에 JSON 하나씩 오는 응답을 읽는다. 각 이벤트는 오는 대로 onEvent로 넘기고(호출한 스레드에서),
    /// "done" 이벤트는 반환하고, "error" 이벤트는 예외로 던진다.
    /// </summary>
    public static async Task<JsonNode> StreamAsync(string path, object body, Action<JsonNode> onEvent)
    {
        using HttpResponseMessage response = await SendAsync(HttpMethod.Post, path, body, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            JsonNode? failure = JsonNode.Parse(await response.Content.ReadAsStringAsync());
            throw new InvalidOperationException(failure?["error"]?.ToString() ?? $"HTTP {(int)response.StatusCode}");
        }
        using System.IO.StreamReader reader = new(await response.Content.ReadAsStreamAsync(), Encoding.UTF8);
        while (await ReadLineOrBreakAsync(reader) is { } line)
        {
            if (line.Length == 0 || JsonNode.Parse(line) is not { } item) continue;
            switch (item["type"]?.ToString())
            {
                case "done": return item;
                case "error":
                    // AI 응답 실패·취소 직전 커밋된 변경도 되돌리기 카드를 잃지 않는다.
                    if (item["applied"] is JsonArray applied) onEvent(new JsonObject { ["type"] = "changes", ["applied"] = applied.DeepClone() });
                    throw new InvalidOperationException(item["error"]?.ToString() ?? "답변을 만들지 못했습니다.");
                default: onEvent(item); break;
            }
        }
        throw StreamBroken();
    }

    // 답을 받는 중에 서비스가 꺼지면: 같은 질문을 다시 보내지 않는다(도면 변경이 이미 실행됐을 수 있다).
    // 다음 질문을 위해 서비스는 다시 띄워 둔다.
    private static async Task<string?> ReadLineOrBreakAsync(System.IO.StreamReader reader)
    {
        try { return await reader.ReadLineAsync(); }
        catch (System.Exception ex) when (ex is System.IO.IOException or HttpRequestException) { throw StreamBroken(); }
    }

    private static InvalidOperationException StreamBroken()
    {
        _ = NodeService.EnsureReadyAsync(TimeSpan.FromSeconds(15));
        return new InvalidOperationException("답을 받는 중에 로컬 서비스 연결이 끊겼습니다. 서비스는 다시 연결합니다. " +
            "도면이 이미 바뀌었을 수 있으니 도면을 확인한 뒤 다시 질문해 주세요.");
    }

    // 보통 요청: 응답 JSON 전체를 받는다. 실패하면 서버가 준 error 문구로 예외.
    public static async Task<JsonNode> RequestAsync(HttpMethod method, string path, object? body = null)
    {
        using HttpResponseMessage response = await SendAsync(method, path, body, HttpCompletionOption.ResponseContentRead);
        string text = await response.Content.ReadAsStringAsync();
        JsonNode? data = JsonNode.Parse(text);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(data?["error"]?.ToString() ?? $"HTTP {(int)response.StatusCode}");
        return data ?? throw new InvalidOperationException("서비스 응답이 비어 있습니다.");
    }
}
