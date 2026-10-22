using System.Net.Http;
using System.Text.Json.Nodes;

namespace Autodesk.AutoCAD.ApplicationServices
{
    public static class Application
    {
        public static object GetSystemVariable(string name) => 0;
    }
}

namespace MyCivil3DMcp.Plugin
{
    internal static class NodeService
    {
        public static string? LastError => null;
        public static void Start() { }
    }

    internal static class DrawingGuard
    {
        public static void Begin() { }
        public static void End() { }
    }

    internal static class PaletteApiClient
    {
        public static readonly Dictionary<string, string> Actual = new()
        {
            ["claude"] = "missing", ["codex"] = "missing", ["gemini"] = "missing"
        };
        public static readonly Dictionary<string, string> Cached = new(Actual);
        public static bool Opened = true;
        public static bool CheckFails;
        public static string? SetupAction;
        public static int Checks;

        public static Task<JsonNode> RequestAsync(HttpMethod method, string path, object? body = null)
        {
            JsonNode request = System.Text.Json.JsonSerializer.SerializeToNode(body) ?? new JsonObject();
            string provider = request["provider"]?.ToString() ?? "";
            if (path == "/api/provider/check")
            {
                Checks++;
                if (CheckFails)
                {
                    return Task.FromException<JsonNode>(new HttpRequestException("test connection failure"));
                }

                Cached[provider] = Actual[provider];
                return Task.FromResult<JsonNode>(new JsonObject { ["state"] = Actual[provider] });
            }

            if (path == "/api/provider/setup")
            {
                SetupAction = request["action"]?.ToString();
                return Task.FromResult<JsonNode>(new JsonObject { ["opened"] = Opened, ["message"] = "setup result" });
            }

            if (path == "/api/providers")
            {
                JsonArray providers = new();
                foreach ((string name, string state) in Cached)
                {
                    providers.Add(new JsonObject { ["provider"] = name, ["state"] = state });
                }

                return Task.FromResult<JsonNode>(new JsonObject { ["providers"] = providers });
            }

            return Task.FromResult<JsonNode>(new JsonObject());
        }

        public static Task<JsonNode> StreamAsync(string path, object body, Action<JsonNode> onEvent) =>
            throw new InvalidOperationException("Chat must not run during setup tests.");
    }
}
