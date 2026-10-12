using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

// Windows .NET Framework launcher. The signed bundle and existing installer are embedded.
internal static class Installer
{
    [STAThread]
    private static int Main(string[] args)
    {
        string work = Path.Combine(Path.GetTempPath(), "MyCivil3DMcp-install-" + Guid.NewGuid().ToString("N"));
        bool owned = false;
        try
        {
            if (args.Length != 0 && !(args.Length == 2 && args[0] == "--extract"))
                throw new ArgumentException("Supported option: --extract <empty directory>");
            if (args.Length == 2) work = Path.GetFullPath(args[1]);
            if (Directory.Exists(work)) throw new IOException("Extraction directory already exists.");
            Directory.CreateDirectory(work);
            owned = true;
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive archive = new ZipArchive(source, ZipArchiveMode.Read))
            {
                string root = Path.GetFullPath(work) + Path.DirectorySeparatorChar;
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(root, entry.FullName));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase) || entry.FullName.Contains(":"))
                        throw new IOException("Invalid installer archive path.");
                    if (entry.Name.Length == 0) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open())
                    using (Stream output = new FileStream(target, FileMode.CreateNew)) input.CopyTo(output);
                }
            }
            if (args.Length == 2) return 0;
            using (var process = Process.Start(new ProcessStartInfo {
                FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
                Arguments = "-NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(work, "installer-ui.ps1") + "\"",
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = work
            })) { process.WaitForExit(); return process.ExitCode; }
        }
        catch (Exception error)
        {
            if (args.Length == 0) MessageBox.Show(error.Message, "My Civil 3D MCP", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            if (args.Length == 0 && owned && Directory.Exists(work))
                try { Directory.Delete(work, true); } catch { }
        }
    }
}
