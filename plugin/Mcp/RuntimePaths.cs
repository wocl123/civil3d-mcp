using System.IO;
using System.Text.Json.Nodes;

namespace MyCivil3DMcp.Plugin;

// 경로 해석은 CAD API와 분리한다. 번들 파일 누락이 개발 PC의 경로로 가려지지 않게 한다.
internal static class RuntimePaths
{
    public static bool IsBundle(string assemblyDirectory) =>
        File.Exists(Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "..", "PackageContents.xml")));

    public static string Server(string assemblyDirectory, string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
        if (IsBundle(assemblyDirectory)) return Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "server", "build", "localService.js"));
        return Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "..", "..", "..", "server", "build", "localService.js"));
    }

    public static string? Node(string assemblyDirectory, string? path)
    {
        string bundled = Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "node", "node.exe"));
        if (File.Exists(bundled)) return bundled;
        foreach (string dir in (path ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
            catch (ArgumentException) { }
        }
        return null;
    }

    public static string Version(string assemblyDirectory)
    {
        try
        {
            string file = Path.Combine(assemblyDirectory, "..", "version.json");
            return JsonNode.Parse(File.ReadAllText(file))?["version"]?.ToString() ?? "development";
        }
        catch (System.Exception) { return "development"; }
    }
}
