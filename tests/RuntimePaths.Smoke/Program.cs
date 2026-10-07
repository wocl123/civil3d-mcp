using MyCivil3DMcp.Plugin;

string root = Path.Combine(Path.GetTempPath(), "mycivil3d-paths-" + Guid.NewGuid().ToString("N"));
void Equal(string? actual, string? expected) { if (actual != expected) throw new Exception($"Expected {expected}, got {actual}"); }
try
{
    string bundle = Path.Combine(root, "한글 배포", "MyCivil3DMcp.bundle");
    string plugin = Path.Combine(bundle, "Contents", "plugin");
    string node = Path.Combine(bundle, "Contents", "node", "node.exe");
    string fallback = Path.Combine(root, "PATH Node", "node.exe");
    Directory.CreateDirectory(plugin); Directory.CreateDirectory(Path.GetDirectoryName(node)!); Directory.CreateDirectory(Path.GetDirectoryName(fallback)!);
    File.WriteAllText(Path.Combine(bundle, "PackageContents.xml"), "test");
    File.WriteAllText(node, "test"); File.WriteAllText(fallback, "test");
    Equal(RuntimePaths.Server(plugin, null), Path.Combine(bundle, "Contents", "server", "build", "localService.js"));
    string explicitEntry = Path.Combine(root, "dev override.js");
    Equal(RuntimePaths.Server(plugin, explicitEntry), explicitEntry);
    Equal(RuntimePaths.Node(plugin, Path.GetDirectoryName(fallback)), node);
    File.Delete(node);
    Equal(RuntimePaths.Node(plugin, '"' + Path.GetDirectoryName(fallback) + '"'), fallback);
    Equal(RuntimePaths.Node(plugin, null), null);
    string dev = Path.Combine(root, "repo", "plugin", "bin", "Release", "net8.0-windows");
    Directory.CreateDirectory(dev);
    Equal(RuntimePaths.Server(dev, null), Path.Combine(root, "repo", "server", "build", "localService.js"));
    Equal(RuntimePaths.Version(plugin), "development");
    File.WriteAllText(Path.Combine(bundle, "Contents", "version.json"), "{\"version\":\"0.1.0\"}");
    Equal(RuntimePaths.Version(plugin), "0.1.0");
    Console.WriteLine("Runtime paths passed: bundle, override, missing runtime, PATH fallback, development, Korean/space paths, version.");
}
finally { Directory.Delete(root, true); }
