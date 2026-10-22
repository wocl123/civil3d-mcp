using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Text.Json;
using Autodesk.AutoCAD.Runtime;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace CivilCrud.Native;

public partial class Commands
{
    [CommandMethod("MYC3DLOADTEST")]
    public void TestPluginLoad()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_LOAD_TEST_DIR")!;
        object result;
        try
        {
            Assembly assembly = AppDomain.CurrentDomain.GetAssemblies().Single(a => a.GetName().Name == "MyCivil3DMcp.Plugin");
            string expected = Environment.GetEnvironmentVariable("MY_CIVIL3D_TEST_PLUGIN")!;
            if (!string.Equals(Path.GetFullPath(assembly.Location), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("A different installed plugin was loaded: " + assembly.Location);
            Type service = assembly.GetType("MyCivil3DMcp.Plugin.NodeService", true)!;
            Type bridge = assembly.GetType("MyCivil3DMcp.Plugin.PluginBridge", true)!;
            object? Property(Type type, string name) => type.GetProperty(name, BindingFlags.Static | BindingFlags.Public)!.GetValue(null);
            if (Property(bridge, "IsRunning") is not true) throw new InvalidOperationException("Plugin Initialize did not start its bridge.");
            string entry = (string)Property(service, "EntryPath")!;
            if (!string.Equals(entry, Environment.GetEnvironmentVariable("MY_CIVIL3D_SERVER_ENTRY"), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Plugin started a different server: " + entry);
            int port = (int)Property(service, "Port")!;
            bool ready = false;
            Stopwatch clock = Stopwatch.StartNew();
            while (clock.Elapsed < TimeSpan.FromSeconds(15))
            {
                if (Property(service, "IsRunning") is not true) throw new InvalidOperationException("Node service failed: " + Property(service, "LastError"));
                try
                {
                    using TcpClient client = new();
                    using CancellationTokenSource timeout = new(TimeSpan.FromMilliseconds(500));
                    client.ConnectAsync("127.0.0.1", port, timeout.Token).AsTask().GetAwaiter().GetResult();
                    ready = true;
                    break;
                }
                catch (SocketException) { Thread.Sleep(100); }
                catch (OperationCanceledException) { Thread.Sleep(100); }
            }
            if (!ready) throw new InvalidOperationException("Node service did not listen within 15 seconds.");
            result = new { passed = true, plugin = assembly.Location, entry, bridgeStarted = true, serviceReady = true };
        }
        catch (System.Exception error) { result = new { passed = false, failure = error.ToString() }; }
        File.WriteAllText(Path.Combine(folder, "load-result.json"), JsonSerializer.Serialize(result));
    }

    [CommandMethod("MYC3DDEVLOAD")]
    public void LoadDevelopmentPlugin()
    {
        var document = App.DocumentManager.MdiActiveDocument;
        string expected = Environment.GetEnvironmentVariable("MY_CIVIL3D_TEST_PLUGIN")!;
        Assembly? loaded = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a => a.GetName().Name == "MyCivil3DMcp.Plugin");
        if (loaded is not null && !string.Equals(Path.GetFullPath(loaded.Location), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
        {
            document.Editor.WriteMessage("\n설치본 DLL이 이미 로드돼 있습니다: " + loaded.Location +
                "\n전용 테스트 프로필에서 번들 자동 로드를 끄고 Civil 3D를 재시작한 뒤 다시 실행하세요.\n");
            return;
        }
        // 설치본이 이미 로드된 경우에는 개발 환경 변수도 적용하지 않는다.
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_LOAD_TEST_DIR")!;
        Environment.SetEnvironmentVariable("MY_CIVIL3D_DATA_DIR", Path.Combine(folder, "data"));
        Environment.SetEnvironmentVariable("MY_CIVIL3D_CONNECTION_DIR", Path.Combine(folder, "connections"));
        Environment.SetEnvironmentVariable("MY_CIVIL3D_SERVER_ENTRY", Path.GetFullPath(Path.Combine(Path.GetDirectoryName(expected)!, "..", "..", "..", "..", "server", "build", "localService.js")));
        Environment.SetEnvironmentVariable("MY_CIVIL3D_SYNC", "off");
        Environment.SetEnvironmentVariable("MY_CIVIL3D_AUTO_UPDATE", "off");
        string command = loaded is null ? "_.NETLOAD \"" + expected.Replace('\\', '/') + "\"\n" : "";
        document.SendStringToExecute("(setvar \"FILEDIA\" 0)\n" + command +
            "MYC3DCONNECTION\nMYC3DCHAT\n(setvar \"FILEDIA\" 1)\n", true, false, false);
    }
}
