using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace MyCivil3DMcp.Plugin;

/// <summary>Local JSON-RPC bridge for the Node process.</summary>
public static class PluginBridge
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };
    private const int DefaultPort = 48761;
    private const int MaxRequestBytes = 1024 * 1024;
    private static TcpListener? _listener;
    private static CancellationTokenSource? _cancellation;
    private static string? _token;

    public static bool IsRunning => _listener is not null;
    internal static string? SessionToken => _token;
    public static int Port { get; private set; } = DefaultPort;
    public static string ConnectionFilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "MyCivil3DMcp", "connection.json");

    public static void Start()
    {
        if (_listener is not null) return;

        string? configuredPort = Environment.GetEnvironmentVariable("MY_CIVIL3D_PORT");
        int port = string.IsNullOrWhiteSpace(configuredPort)
            ? DefaultPort
            : int.TryParse(configuredPort, out int parsedPort) && parsedPort is > 0 and <= 65535
                ? parsedPort
                : throw new ArgumentException("MY_CIVIL3D_PORT must be between 1 and 65535.");

        TcpListener listener = new(IPAddress.Loopback, port);
        listener.Start();
        CancellationTokenSource cancellation = new();
        string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ConnectionFilePath)!);
            File.WriteAllText(ConnectionFilePath,
                JsonSerializer.Serialize(new { port, token }), new UTF8Encoding(false));
        }
        catch
        {
            listener.Stop();
            cancellation.Dispose();
            throw;
        }

        Port = port;
        _token = token;
        _cancellation = cancellation;
        _listener = listener;
        _ = AcceptLoopAsync(listener, cancellation.Token);
    }

    public static void Stop()
    {
        string? ownToken = _token;
        _cancellation?.Cancel();
        _listener?.Stop();
        _listener = null;
        _cancellation?.Dispose();
        _cancellation = null;
        _token = null;
        try
        {
            if (ownToken is not null && File.Exists(ConnectionFilePath))
            {
                JsonObject? config = JsonNode.Parse(File.ReadAllText(ConnectionFilePath)) as JsonObject;
                if (config?["token"]?.ToString() == ownToken) File.Delete(ConnectionFilePath);
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (JsonException) { }
    }

    private static async Task AcceptLoopAsync(TcpListener listener, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                TcpClient client = await listener.AcceptTcpClientAsync(cancellationToken);
                _ = HandleClientAsync(client, cancellationToken);
            }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (SocketException) when (cancellationToken.IsCancellationRequested) { break; }
        }
    }

    private static async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
    {
        using (client)
        {
            try
            {
                await using NetworkStream stream = client.GetStream();
                using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(TimeSpan.FromMinutes(10));
                string requestText = await ReadRequestAsync(stream, timeout.Token);
                object response = await DispatchAsync(requestText);
                byte[] bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response, JsonOptions) + "\n");
                await stream.WriteAsync(bytes, cancellationToken);
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (SocketException) { }
            catch (InvalidDataException) { }
        }
    }

    private static async Task<string> ReadRequestAsync(NetworkStream stream, CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[8192];
        using MemoryStream request = new();
        while (true)
        {
            int count = await stream.ReadAsync(buffer, cancellationToken);
            if (count == 0) throw new InvalidDataException("Request ended before newline.");
            int end = Array.IndexOf(buffer, (byte)'\n', 0, count);
            int length = end < 0 ? count : end;
            if (request.Length + length > MaxRequestBytes)
                throw new InvalidDataException("Request exceeds 1 MiB.");
            request.Write(buffer, 0, length);
            if (end >= 0) return Encoding.UTF8.GetString(request.ToArray());
        }
    }

    private static async Task<object> DispatchAsync(string requestText)
    {
        JsonNode? request;
        try { request = JsonNode.Parse(requestText); }
        catch (JsonException) { return Failure(null, -32700, "Invalid JSON."); }

        if (request is not JsonObject requestObject)
            return Failure(null, -32600, "Invalid JSON-RPC request.");
        string? id = requestObject["id"]?.ToString();
        if (requestObject["jsonrpc"]?.ToString() != "2.0")
            return Failure(id, -32600, "Invalid JSON-RPC request.");
        if (!IsAuthorized(requestObject["token"]?.ToString()))
            return Failure(id, -32001, "Unauthorized.");

        try
        {
            if (requestObject["params"] is not null and not JsonObject)
                throw new ArgumentException("params must be a JSON object.");
            JsonObject? parameters = requestObject["params"] as JsonObject;
            object result = requestObject["method"]?.ToString() switch
            {
                "drawing.status" => await InDocumentContextAsync(doc => DrawingQueries.GetStatus(doc)),
                "drawing.objects" => await InDocumentContextAsync(doc => DrawingQueries.GetObjects(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 20),
                    parameters?["layer"]?.ToString())),
                "drawing.layers" => await InDocumentContextAsync(doc => DrawingQueries.GetLayers(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 50))),
                "drawing.object" => await InDocumentContextAsync(doc => DrawingQueries.GetObject(
                    doc, ReadString(parameters?["handle"]))),
                "alignment.list" => await InDocumentContextAsync(doc => AlignmentQueries.ListAlignments(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 50))),
                "alignment.get" => await InDocumentContextAsync(doc => AlignmentQueries.GetAlignment(
                    doc, ReadString(parameters?["alignment"]))),
                "alignment.section" => await InDocumentContextAsync(doc => AlignmentQueries.GetAlignmentSection(
                    doc,
                    ReadString(parameters?["alignment"]),
                    ReadString(parameters?["section"]),
                    ReadOptionalNumber(parameters?["fromStation"]),
                    ReadOptionalNumber(parameters?["toStation"]),
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 50))),
                "profile.get" => await InDocumentContextAsync(doc => ProfileQueries.GetProfile(
                    doc,
                    ReadString(parameters?["profile"]),
                    parameters?["alignment"]?.ToString())),
                "change.apply" => await InDocumentEditAsync(doc => DesignChanges.Apply(doc, ReadChanges(parameters?["changes"]))),
                "alignment.create" => await InDocumentEditAsync(doc => AlignmentCreation.Create(doc, ReadCreate(parameters))),
                "drawing.pick_polyline" => await InDocumentContextAsync(doc => DrawingPicker.PickPolyline(
                    doc, parameters?["message"]?.ToString(), Math.Clamp(ReadInt(parameters?["timeoutSeconds"], 90), 10, 110))),
                "drawing.polylines" => await InDocumentContextAsync(doc => DrawingQueries.GetPolylines(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 20),
                    parameters?["layer"]?.ToString())),
                "profile.section" => await InDocumentContextAsync(doc => ProfileQueries.GetProfileSection(
                    doc,
                    ReadString(parameters?["profile"]),
                    parameters?["alignment"]?.ToString(),
                    ReadString(parameters?["section"]),
                    ReadOptionalNumber(parameters?["fromStation"]),
                    ReadOptionalNumber(parameters?["toStation"]),
                    ReadNumbers(parameters?["stations"]),
                    ReadOptionalNumber(parameters?["interval"]),
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 50))),
                _ => throw new MissingMethodException("Unknown bridge method.")
            };
            return new { jsonrpc = "2.0", id, result };
        }
        catch (MissingMethodException) { return Failure(id, -32601, "Method not found."); }
        catch (ArgumentException ex) { return Failure(id, -32602, ex.Message); }
        catch (System.Exception ex) { return Failure(id, -32603, ex.Message); }
    }

    private static int ReadInt(JsonNode? value, int fallback)
    {
        if (value is null) return fallback;
        if (!int.TryParse(value.ToString(), out int parsed))
            throw new ArgumentException("offset and limit must be integers.");
        return parsed;
    }

    private static List<DesignChangeRequest> ReadChanges(JsonNode? value)
    {
        if (value is not JsonArray array || array.Count is 0 or > 20)
            throw new ArgumentException("changes must be an array of 1 to 20 items.");
        return array.Select(item => new DesignChangeRequest(
            ReadString(item?["kind"]), ReadString(item?["handle"]), ReadOptionalNumber(item?["at"]),
            ReadString(item?["property"]), ReadOptionalNumber(item?["from"]),
            ReadOptionalNumber(item?["to"]) ?? throw new ArgumentException("Each change needs a new value (to)."))).ToList();
    }

    private static AlignmentCreateRequest ReadCreate(JsonObject? value) =>
        value?.Deserialize<AlignmentCreateRequest>(ReadOptions) is { Polyline: not null, Points: not null, Curves: not null } request
            ? request
            : throw new ArgumentException("alignment.create needs name, type, polyline, points, and curves.");

    private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };

    private static string ReadString(JsonNode? value) => value?.ToString() ??
        throw new ArgumentException("Required text parameter is missing.");

    private static double? ReadOptionalNumber(JsonNode? value) =>
        value is null ? null : ReadNumbers(new JsonArray(value.DeepClone()))[0];

    private static double[] ReadNumbers(JsonNode? value)
    {
        if (value is null) return [];
        if (value is not JsonArray array) throw new ArgumentException("stations must be an array of numbers.");
        return array.Select(item => double.TryParse(item?.ToString(), System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out double number) && double.IsFinite(number)
            ? number : throw new ArgumentException("Each station must be a finite number.")).ToArray();
    }

    private static bool IsAuthorized(string? candidate)
    {
        if (_token is null || candidate is null) return false;
        try
        {
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(candidate), Convert.FromHexString(_token));
        }
        catch (FormatException) { return false; }
    }

    private static async Task<object> InDocumentContextAsync(Func<Document, object> query)
    {
        object? result = null;
        System.Exception? error = null;
        await App.DocumentManager.ExecuteInCommandContextAsync(async _ =>
        {
            try
            {
                Document document = App.DocumentManager.MdiActiveDocument
                    ?? throw new InvalidOperationException("No active drawing.");
                using DocumentLock documentLock = document.LockDocument();
                result = query(document);
            }
            catch (System.Exception ex) { error = ex; }
            await Task.CompletedTask;
        }, null);
        if (error is not null) throw error;
        return result!;
    }

    // Like InDocumentContextAsync, but the edits form one UNDO group, so one Ctrl+Z
    // (or UNDO 1) reverts all of them. The group is closed even when the edit fails.
    private static async Task<object> InDocumentEditAsync(Func<Document, object> edit)
    {
        object? result = null;
        System.Exception? error = null;
        await App.DocumentManager.ExecuteInCommandContextAsync(async _ =>
        {
            Document? document = App.DocumentManager.MdiActiveDocument;
            try
            {
                if (document is null) throw new InvalidOperationException("No active drawing.");
                using DocumentLock documentLock = document.LockDocument();
                document.Editor.Command("_.UNDO", "_BEgin");
                try { result = edit(document); }
                finally { document.Editor.Command("_.UNDO", "_End"); }
            }
            catch (System.Exception ex) { error = ex; }
            await Task.CompletedTask;
        }, null);
        if (error is not null) throw error;
        return result!;
    }

    private static object Failure(string? id, int code, string message) =>
        new { jsonrpc = "2.0", id, error = new { code, message } };
}
