using System.IO;
using System.Diagnostics;

namespace MyCivil3DMcp.Plugin;

// Node 로컬 서비스(server/build/localService.js)를 띄우고 끈다.
// 팔레트는 이 서비스(127.0.0.1:48900)에 질문을 보내고, 서비스가 AI CLI를 실행한다.
// MY_CIVIL3D_SERVER_ENTRY 로 다른 경로의 서비스를 쓸 수 있다.
internal static class NodeService
{
    private static Process? _process;
    public static bool IsRunning => _process is { HasExited: false };
    public static string? LastError { get; private set; }

    public static void Start()
    {
        if (IsRunning) return;
        // 기본 위치: 플러그인 dll 기준 ../../../../server/build/localService.js
        string? configured = Environment.GetEnvironmentVariable("MY_CIVIL3D_SERVER_ENTRY");
        string assemblyDirectory = Path.GetDirectoryName(typeof(NodeService).Assembly.Location)!;
        string entry = string.IsNullOrWhiteSpace(configured)
            ? Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "..", "..", "..", "server", "build", "localService.js"))
            : Path.GetFullPath(configured);
        if (!File.Exists(entry))
        {
            LastError = $"Node 서비스 파일이 없습니다: {entry}. 서버에서 npm run build를 실행하세요.";
            return;
        }

        _process?.Dispose();
        ProcessStartInfo start = new("node.exe")
        {
            WorkingDirectory = Path.GetDirectoryName(entry)!,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        start.ArgumentList.Add(entry);
        // 이 Civil 3D가 끝나면 서비스도 끝나고, 포트를 잡고 있는 이전 서비스는 서비스가 직접 내린다.
        start.Environment["MY_CIVIL3D_PARENT_PID"] = Environment.ProcessId.ToString();
        try
        {
            _process = Process.Start(start);
            LastError = _process is null ? "Node 서비스를 시작하지 못했습니다." : null;
        }
        catch (System.Exception ex)
        {
            LastError = "Node 서비스를 시작하지 못했습니다: " + ex.Message;
        }
    }

    // 서비스와 그 자식 프로세스(실행 중인 AI CLI)까지 끈다.
    public static void Stop()
    {
        if (_process is null) return;
        try
        {
            if (!_process.HasExited) _process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) { }
        catch (System.ComponentModel.Win32Exception) { }
        finally { _process.Dispose(); _process = null; }
    }
}
