using System.IO;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace MyCivil3DMcp.Plugin;

// Node 로컬 서비스(server/build/localService.js)를 띄우고 끈다.
// 팔레트는 이 서비스(127.0.0.1:48900)에 질문을 보내고, 서비스가 AI CLI를 실행한다.
// MY_CIVIL3D_SERVER_ENTRY 로 다른 경로의 서비스를 쓸 수 있다.
//
// 배포 PC에서 원인을 알 수 있게, 서비스가 내보내는 글과 시작·종료(종료 코드)를
// data/logs/<날짜>/service.log 에 남긴다. 이 PC에만 남고 중앙으로 보내지 않는다.
// 서비스가 비정상으로 꺼지면 다시 띄운다. 계속 죽으면(10분에 3번) 멈추고 오류로 알린다.
//
// 포트: 48900이 비어 있으면 쓰고, 다른 프로그램(또는 다른 Civil 3D의 서비스)이 쓰고 있으면 빈 포트를 골라
// 서비스에 넘긴다. 팔레트는 Port 로 따라간다. 서비스에는 이 Civil 3D 전용 연결 파일을 넘긴다.
internal static class NodeService
{
    private const int MaxRestarts = 3;
    private static readonly TimeSpan RestartWindow = TimeSpan.FromMinutes(10);

    private static readonly object Gate = new();
    private static readonly object LogGate = new();
    private static readonly Queue<DateTime> Restarts = new();
    private static Process? _process;
    private static bool _stopping;

    public static bool IsRunning { get { lock (Gate) return _process is { HasExited: false }; } }
    public static string? LastError { get; private set; }

    public static string? EntryPath { get; private set; }
    public static string? NodePath { get; private set; }
    public static string NodeVersion { get; private set; } = "unknown";
    public static string ProductVersion { get; private set; } = "development";

    private const int DefaultPort = 48900;
    private static int _port = DefaultPort;

    // 서비스 포트(마지막으로 띄운 서비스의 것). 팔레트 HTTP 호출도 이 값을 쓴다.
    public static int Port => _port;

    public static void Start()
    {
        lock (Gate)
        {
            if (_process is { HasExited: false }) return;
            _stopping = false;
            Launch("start");
        }
    }

    // 서비스가 꺼져 있으면 띄우고, 포트가 열릴 때까지 기다린다(팔레트 요청을 다시 보내기 전).
    public static async Task<bool> EnsureReadyAsync(TimeSpan timeout)
    {
        lock (Gate)
        {
            if (_process is not { HasExited: false })
            {
                _stopping = false;
                Restarts.Clear();   // 사용자가 다시 시도한 것이므로 자동 재시작 제한을 풀어 준다.
                Launch("start on request");
            }
        }
        Stopwatch clock = Stopwatch.StartNew();
        while (clock.Elapsed < timeout)
        {
            if (await PortOpenAsync()) return true;
            if (!IsRunning) return false;
            await Task.Delay(250);
        }
        return false;
    }

    // 서비스와 그 자식 프로세스(실행 중인 AI CLI)까지 끈다.
    public static void Stop()
    {
        // 잠금은 짧게: 끄는 동안 Exited 처리가 같은 잠금을 기다리면 서로 멈춘다.
        Process? process;
        lock (Gate)
        {
            _stopping = true;
            process = _process;
            _process = null;
        }
        if (process is null) return;
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally { process.Dispose(); }
        Log("stopped by Civil 3D");
    }

    // Gate 안에서 부른다.
    private static void Launch(string reason)
    {
        string assemblyDirectory = Path.GetDirectoryName(typeof(NodeService).Assembly.Location)!;
        EntryPath = RuntimePaths.Server(assemblyDirectory, Environment.GetEnvironmentVariable("MY_CIVIL3D_SERVER_ENTRY"));
        ProductVersion = RuntimePaths.Version(assemblyDirectory);
        if (!File.Exists(EntryPath))
        {
            LastError = $"Node 서비스 파일이 없습니다: {EntryPath}. 배포본을 다시 설치하거나 개발 서버를 빌드하세요.";
            Log(LastError);
            return;
        }
        NodePath = RuntimePaths.Node(assemblyDirectory, Environment.GetEnvironmentVariable("PATH"));
        if (NodePath is null)
        {
            LastError = "Node 실행 파일이 없습니다. 배포본을 다시 설치하거나 지원하는 Node.js를 설치하세요.";
            Log(LastError);
            return;
        }
        // PATH 대체 실행도 최소 버전을 확인한다. 설치돼 있다는 사실만으로 호환성을 보장하지 않는다.
        try
        {
            ProcessStartInfo probe = new(NodePath) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            probe.ArgumentList.Add("--version");
            using Process version = Process.Start(probe)!;
            if (!version.WaitForExit(3000)) { version.Kill(entireProcessTree: true); throw new InvalidOperationException("Node 버전 확인 시간 초과"); }
            NodeVersion = version.StandardOutput.ReadToEnd().Trim();
            if (version.ExitCode != 0 || !int.TryParse(NodeVersion.TrimStart('v').Split('.')[0], out int major) || major < 20)
                throw new InvalidOperationException("Node.js 20 이상이 필요합니다: " + NodeVersion);
        }
        catch (System.Exception ex) { LastError = "Node 실행 확인 실패: " + ex.Message; Log(LastError); return; }
        string entry = EntryPath;

        // 꺼진 이전 프로세스는 따로 정리한다(자기 Exited 처리 안에서 Dispose 하지 않게).
        Process? previous = _process;
        _process = null;
        if (previous is not null) _ = Task.Run(previous.Dispose);
        ProcessStartInfo start = new(NodePath)
        {
            WorkingDirectory = Path.GetDirectoryName(entry)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            // 출력을 받아 service.log 에 쓴다. 읽어 주지 않으면 버퍼가 차서 서비스가 멈추므로 끝까지 읽는다.
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8
        };
        start.ArgumentList.Add(entry);
        // npm .cmd와 CLI 도우미도 동봉 Node를 찾게 한다. 시스템 PATH는 변경하지 않는다.
        string runtimeDirectory = Path.GetDirectoryName(NodePath)!;
        start.Environment["PATH"] = runtimeDirectory + Path.PathSeparator + Environment.GetEnvironmentVariable("PATH");
        start.Environment["MY_CIVIL3D_NODE_EXE"] = NodePath;
        start.Environment["MY_CIVIL3D_CLAUDE_QUOTA_MODE"] = RuntimePaths.IsBundle(assemblyDirectory) ? "statusline" : "sdk";
        // 이 Civil 3D가 끝나면 서비스도 끝나고, 포트를 잡고 있는 이전 서비스는 서비스가 직접 내린다.
        start.Environment["MY_CIVIL3D_PARENT_PID"] = Environment.ProcessId.ToString();
        _port = ChoosePort();
        start.Environment["MY_CIVIL3D_SERVICE_PORT"] = _port.ToString();
        start.Environment["MY_CIVIL3D_CONNECTION_FILE"] = PluginBridge.OwnConnectionFilePath;
        try
        {
            Process process = new() { StartInfo = start, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) => { if (e.Data is not null) Log(e.Data); };
            process.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log(e.Data); };
            process.Exited += (_, _) => OnExited(process);
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;
            LastError = null;
            Log($"started ({reason}): pid {process.Id}, port {_port}, {entry}");
        }
        catch (System.Exception ex)
        {
            LastError = "Node 서비스를 시작하지 못했습니다: " + ex.Message +
                (ex is System.ComponentModel.Win32Exception ? " (Node.js가 설치되어 있는지 확인하세요.)" : "");
            Log(LastError);
        }
    }

    // 서비스가 스스로 꺼졌을 때: 기록하고 다시 띄운다.
    private static void OnExited(Process process)
    {
        int code;
        try { code = process.ExitCode; } catch (InvalidOperationException) { code = -1; }
        lock (Gate)
        {
            if (_stopping || !ReferenceEquals(process, _process)) return;
            Log($"exited with code {code}");
            // 0: 정상 종료(나중에 켜진 다른 Civil 3D의 서비스에 자리를 넘김). 다시 띄우면 포트를 서로 빼앗는다.
            if (code == 0) return;

            DateTime now = DateTime.UtcNow;
            while (Restarts.Count > 0 && now - Restarts.Peek() > RestartWindow) Restarts.Dequeue();
            if (Restarts.Count >= MaxRestarts)
            {
                LastError = $"Node 서비스가 계속 종료됩니다(종료 코드 {code}). 기록: {LogPath()}";
                Log("not restarting: too many exits in 10 minutes");
                return;
            }
            Restarts.Enqueue(now);
            Launch($"restart after exit code {code}");
        }
    }

    // 설정한 포트(MY_CIVIL3D_SERVICE_PORT) → 48900 → 빈 포트 순서.
    private static int ChoosePort()
    {
        string? configured = Environment.GetEnvironmentVariable("MY_CIVIL3D_SERVICE_PORT");
        if (int.TryParse(configured, out int port) && port is > 0 and <= 65535) return port;
        try
        {
            TcpListener probe = new(IPAddress.Loopback, DefaultPort);
            probe.Start();
            probe.Stop();
            return DefaultPort;
        }
        catch (SocketException)
        {
            TcpListener free = new(IPAddress.Loopback, 0);
            free.Start();
            int chosen = ((IPEndPoint)free.LocalEndpoint).Port;
            free.Stop();
            Log($"port {DefaultPort} is in use; using {chosen}");
            return chosen;
        }
    }

    private static async Task<bool> PortOpenAsync()
    {
        try
        {
            using TcpClient client = new();
            using CancellationTokenSource timeout = new(TimeSpan.FromSeconds(1));
            await client.ConnectAsync("127.0.0.1", Port, timeout.Token);
            return true;
        }
        catch (System.Exception) { return false; }
    }

    // 서비스 데이터 폴더와 같은 곳(MY_CIVIL3D_DATA_DIR 또는 %LOCALAPPDATA%\MyCivil3DMcp\data).
    private static string LogPath()
    {
        string? configured = Environment.GetEnvironmentVariable("MY_CIVIL3D_DATA_DIR");
        string data = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MyCivil3DMcp", "data")
            : configured;
        return Path.Combine(data, "logs", DateTime.Now.ToString("yyyy-MM-dd"), "service.log");
    }

    // 기록 실패는 무시한다(기록 때문에 서비스가 멈추면 안 된다).
    private static void Log(string line)
    {
        try
        {
            lock (LogGate)
            {
                string path = LogPath();
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.AppendAllText(path, $"{DateTime.Now:HH:mm:ss.fff} {line}{Environment.NewLine}", new UTF8Encoding(false));
            }
        }
        catch (System.Exception) { }
    }
}
