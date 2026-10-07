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

/// <summary>Node 프로세스가 플러그인을 부르는 로컬 JSON-RPC 브리지.</summary>
// 127.0.0.1:48761(MY_CIVIL3D_PORT)에서 연결 하나에 요청 한 줄, 응답 한 줄.
// 시작할 때 무작위 토큰을 만들어 %LOCALAPPDATA%\MyCivil3DMcp\connection.json 에 쓰고,
// 그 토큰을 가진 요청만 받는다. 도면 작업은 모두 Civil 3D 명령 컨텍스트에서 실행한다.
public static class PluginBridge
{
    // 값이 없는 항목은 null로 쓰지 않고 뺀다: 결과가 모두 AI 문맥에 들어가는데,
    // 선형 요소 하나만 해도 선택 항목이 스무 개쯤 된다.
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
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

    // 포트를 열고, 토큰을 만들어 연결 파일에 쓴 뒤 접속을 받기 시작한다.
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

    // 닫는다. 연결 파일은 내 토큰이 들어 있을 때만 지운다(다른 Civil 3D가 쓴 파일은 두기).
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

    // 요청 읽기에 10분 제한을 둔다. 실행 중인 CAD 편집은 응답 유실만으로 취소되었다고 단정할 수 없다.
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

    // 줄바꿈까지 읽는다(1 MiB까지).
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

    // JSON-RPC 요청 검사(형식, 토큰) 후 method에 맞는 조회·편집을 실행한다.
    //   drawing.*    도면 상태, 객체, 레이어, 선택, 요약, 캡처, 폴리선 고르기
    //   alignment.*  선형 목록·상세·구간, 선형 만들기
    //   profile.*    종단 상세·구간
    //   change.apply 설계 값 바꾸기 (편집은 Undo 한 번으로 되돌릴 수 있게 묶음)
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
            JsonObject? context = requestObject["context"] as JsonObject;
            Task<object> Read(Func<Document, object> query) => InDocumentContextAsync(query, context);
            object result = requestObject["method"]?.ToString() switch
            {
                // ── 도면 조회
                "drawing.status" => await Read(doc => DrawingQueries.GetStatus(doc)),
                "drawing.objects" => await Read(doc => DrawingQueries.GetObjects(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 20),
                    parameters?["layer"]?.ToString())),
                "drawing.layers" => await Read(doc => DrawingQueries.GetLayers(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 50))),
                "drawing.object" => await Read(doc => DrawingQueries.GetObject(
                    doc, ReadString(parameters?["handle"]))),
                // ── 선형·종단 조회
                "alignment.list" => await Read(doc => AlignmentQueries.ListAlignments(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 50))),
                "alignment.get" => await Read(doc => AlignmentQueries.GetAlignment(
                    doc, ReadString(parameters?["alignment"]))),
                "alignment.section" => await Read(doc => AlignmentQueries.GetAlignmentSection(
                    doc,
                    ReadString(parameters?["alignment"]),
                    ReadString(parameters?["section"]),
                    ReadOptionalNumber(parameters?["fromStation"]),
                    ReadOptionalNumber(parameters?["toStation"]),
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 50))),
                "drawing.delete_preview" => await Read(doc => DrawingDeletion.Preview(doc, parameters)),
                "profile.get" => await Read(doc => ProfileQueries.GetProfile(
                    doc,
                    ReadString(parameters?["profile"]),
                    parameters?["alignment"]?.ToString())),
                // ── 도면 편집
                "change.apply" => await InDocumentContextAsync(doc => DrawingOperations.Apply(doc, parameters, context,
                    () => DesignChanges.Apply(doc, ReadChanges(parameters?["changes"])))),
                "alignment.create" => await InDocumentContextAsync(doc => DrawingOperations.Apply(doc, parameters, context,
                    () => AlignmentCreation.Create(doc, ReadCreate(parameters)))),
                "drawing.delete" => await InDocumentContextAsync(doc => DrawingOperations.Apply(doc, parameters, context,
                    () => DrawingDeletion.Delete(doc, DrawingDeletion.ReadTargets(parameters?["targets"])))),
                "change.undo" => await InDocumentContextAsync(doc => DrawingOperations.Undo(doc, parameters)),
                "change.cancel" => await InDocumentContextAsync(doc => DrawingOperations.Cancel(doc, parameters)),
                "change.result" => await InDocumentContextAsync(doc => DrawingOperations.Result(doc, parameters)),
                // ── 사용자에게 고르게 하기, 화면 캡처, 선택·요약, 그 밖의 조회
                "drawing.pick_polyline" => await Read(doc => DrawingPicker.PickPolyline(
                    doc, parameters?["message"]?.ToString(), Math.Clamp(ReadInt(parameters?["timeoutSeconds"], 90), 10, 110))),
                "drawing.capture" => await Read(doc => DrawingCapture.Capture(
                    doc, ReadStrings(parameters?["handles"]),
                    Math.Clamp(ReadInt(parameters?["width"], 800), 200, 1600),
                    Math.Clamp(ReadInt(parameters?["height"], 600), 200, 1200))),
                "drawing.selection" => await Read(doc => DrawingSelection.Get(doc)),
                "drawing.summary" => await Read(doc => DrawingSummary.Read(doc)),
                "drawing.polylines" => await Read(doc => DrawingQueries.GetPolylines(
                    doc,
                    ReadInt(parameters?["offset"], 0),
                    ReadInt(parameters?["limit"], 20),
                    parameters?["layer"]?.ToString())),
                "profile.section" => await Read(doc => ProfileQueries.GetProfileSection(
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
        catch (BridgeFailure ex) { return new { jsonrpc = "2.0", id, error = new { code = -32002, message = ex.Message, kind = ex.Kind, drawingChanged = ex.DrawingChanged } }; }
        catch (MissingMethodException) { return Failure(id, -32601, "Method not found."); }
        catch (ArgumentException ex) { return Failure(id, -32602, ex.Message); }
        catch (System.Exception ex) { return Failure(id, -32603, ex.Message); }
    }

    // ── 매개변수 읽기. 형식이 틀리면 ArgumentException(→ -32602).

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

    private static string[] ReadStrings(JsonNode? value) => value switch
    {
        null => [],
        JsonArray array => array.Select(item => ReadString(item)).ToArray(),
        _ => throw new ArgumentException("handles must be an array of handles.")
    };

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

    // 토큰 비교(시간이 일정한 비교).
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

    // 조회: 명령 컨텍스트에서 도면을 잠그고 실행한다.
    private static async Task<object> InDocumentContextAsync(Func<Document, object> query, JsonObject? context = null)
    {
        object? result = null;
        System.Exception? error = null;
        // 명령 컨텍스트에 들어가면 사용자의 그립이 지워진다. DrawingSelection이 선택을 기억해 둔다.
        DrawingSelection.BridgeStarted();
        try
        {
            await App.DocumentManager.ExecuteInCommandContextAsync(async _ =>
            {
                try
                {
                    Document document = App.DocumentManager.MdiActiveDocument
                        ?? throw new InvalidOperationException("No active drawing.");
                    using DocumentLock documentLock = document.LockDocument();
                    DrawingOperations.Validate(document, context);
                    result = query(document);
                }
                catch (System.Exception ex) { error = ex; }
                await Task.CompletedTask;
            }, null);
        }
        finally { DrawingSelection.BridgeEnded(); }
        if (error is not null) throw error;
        return result!;
    }

    private static object Failure(string? id, int code, string message) =>
        new { jsonrpc = "2.0", id, error = new { code, message } };
}
