using System.IO;
using System.Text.Json.Nodes;

namespace MyCivil3DMcp.Plugin;

// 경로 해석은 CAD API와 분리한다. 번들 파일 누락이 개발 PC의 경로로 가려지지 않게 한다.
internal static class RuntimePaths
{
    public static bool IsInternal(string assemblyDirectory) =>
        File.Exists(Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "internal-deployment.json")));
    public static bool IsBundle(string assemblyDirectory) =>
        File.Exists(Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "..", "PackageContents.xml")));

    public static string Server(string assemblyDirectory, string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Path.GetFullPath(configured);
        }

        // 번들: 플러그인 폴더 옆의 server 폴더
        if (IsBundle(assemblyDirectory))
        {
            return Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "server", "build", "localService.js"));
        }

        // 개발: 빌드 출력 폴더에서 네 단계 위가 저장소 루트
        string repository = Path.Combine(assemblyDirectory, "..", "..", "..", "..");
        return Path.GetFullPath(Path.Combine(repository, "server", "build", "localService.js"));
    }

    public static string? Node(string assemblyDirectory, string? path)
    {
        string bundled = Path.GetFullPath(Path.Combine(assemblyDirectory, "..", "node", "node.exe"));
        if (File.Exists(bundled))
        {
            return bundled;
        }

        // 번들에 없으면 PATH에서 찾는다.
        foreach (string dir in (path ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                string candidate = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                if (File.Exists(candidate))
                {
                    return Path.GetFullPath(candidate);
                }
            }
            catch (ArgumentException)
            {
                // 경로에 쓸 수 없는 글자가 든 PATH 항목은 건너뛴다.
            }
        }

        return null;
    }

    public static string Version(string assemblyDirectory)
    {
        try
        {
            string file = Path.Combine(assemblyDirectory, "..", "version.json");
            string version = JsonNode.Parse(File.ReadAllText(file))?["version"]?.ToString() ?? "development";
            return IsInternal(assemblyDirectory) ? version + " (internal)" : version;
        }
        catch (System.Exception)
        {
            return "development";
        }
    }
}
