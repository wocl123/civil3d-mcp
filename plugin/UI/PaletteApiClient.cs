using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;

namespace MyCivil3DMcp.Plugin;

internal static class PaletteApiClient
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(4) };

    private static HttpRequestMessage Request(HttpMethod method, string path, object? body)
    {
        string token = PluginBridge.SessionToken ?? throw new InvalidOperationException("Civil 3D 플러그인 연결이 없습니다.");
        string? configured = Environment.GetEnvironmentVariable("MY_CIVIL3D_SERVICE_PORT");
        int port = string.IsNullOrWhiteSpace(configured) ? 48900 : int.Parse(configured);
        HttpRequestMessage request = new(method, $"http://127.0.0.1:{port}{path}");
        request.Headers.Add("X-My-Civil3D-Token", token);
        if (body is not null)
            request.Content = new StringContent(System.Text.Json.JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        return request;
    }

    /// <summary>
    /// Reads a stream of JSON lines. Each event goes to onEvent as it arrives (on the
    /// caller's thread); the "done" event is returned and an "error" event is thrown.
    /// </summary>
    public static async Task<JsonNode> StreamAsync(string path, object body, Action<JsonNode> onEvent)
    {
        using HttpRequestMessage request = Request(HttpMethod.Post, path, body);
        using HttpResponseMessage response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
        {
            JsonNode? failure = JsonNode.Parse(await response.Content.ReadAsStringAsync());
            throw new InvalidOperationException(failure?["error"]?.ToString() ?? $"HTTP {(int)response.StatusCode}");
        }
        using System.IO.StreamReader reader = new(await response.Content.ReadAsStreamAsync(), Encoding.UTF8);
        while (await reader.ReadLineAsync() is { } line)
        {
            if (line.Length == 0 || JsonNode.Parse(line) is not { } item) continue;
            switch (item["type"]?.ToString())
            {
                case "done": return item;
                case "error": throw new InvalidOperationException(item["error"]?.ToString() ?? "답변을 만들지 못했습니다.");
                default: onEvent(item); break;
            }
        }
        throw new InvalidOperationException("서비스 응답이 중간에 끊겼습니다.");
    }

    public static async Task<JsonNode> RequestAsync(HttpMethod method, string path, object? body = null)
    {
        using HttpRequestMessage request = Request(method, path, body);
        using HttpResponseMessage response = await Http.SendAsync(request);
        string text = await response.Content.ReadAsStringAsync();
        JsonNode? data = JsonNode.Parse(text);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(data?["error"]?.ToString() ?? $"HTTP {(int)response.StatusCode}");
        return data ?? throw new InvalidOperationException("서비스 응답이 비어 있습니다.");
    }
}
