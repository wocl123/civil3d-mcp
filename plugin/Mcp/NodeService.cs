using System.IO;
using System.Diagnostics;

namespace MyCivil3DMcp.Plugin;

internal static class NodeService
{
    private static Process? _process;
    public static bool IsRunning => _process is { HasExited: false };
    public static string? LastError { get; private set; }

    public static void Start()
    {
        if (IsRunning) return;
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
