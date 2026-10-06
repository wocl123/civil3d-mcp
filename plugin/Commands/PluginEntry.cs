using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

[assembly: CommandClass(typeof(MyCivil3DMcp.Plugin.PluginEntry))]
[assembly: ExtensionApplication(typeof(MyCivil3DMcp.Plugin.PluginEntry))]

namespace MyCivil3DMcp.Plugin;

public sealed class PluginEntry : IExtensionApplication
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    public void Initialize()
    {
        try
        {
            DrawingRevisions.Start();
            PluginBridge.Start();
            NodeService.Start();
        }
        catch (System.Exception ex)
        {
            App.DocumentManager.MdiActiveDocument?.Editor.WriteMessage(
                $"\nMyCivil3DMcp bridge failed to start: {ex.Message}\n");
        }
    }

    public void Terminate()
    {
        ChatPalette.Dispose();
        NodeService.Stop();
        PluginBridge.Stop();
    }

    [CommandMethod("MYC3DCHAT")]
    public void ShowChat()
    {
        ChatPalette.Show();
    }

    [CommandMethod("MYC3DCONNECTION")]
    public void ShowConnection()
    {
        App.DocumentManager.MdiActiveDocument?.Editor.WriteMessage(
            $"\nMyCivil3DMcp bridge: {(PluginBridge.IsRunning ? "running" : "stopped")}, " +
            $"port {PluginBridge.Port}, service {(NodeService.IsRunning ? "running" : "stopped")}, " +
            $"config {PluginBridge.ConnectionFilePath}" +
            (NodeService.LastError is null ? "\n" : $", error {NodeService.LastError}\n"));
    }

    [CommandMethod("MYC3DSTATUS")]
    public void ShowStatus() => Run(document => DrawingQueries.GetStatus(document));

    [CommandMethod("MYC3DOBJECTS")]
    public void ShowObjects()
    {
        Document? document = App.DocumentManager.MdiActiveDocument;
        if (document is null) return;

        Editor editor = document.Editor;
        PromptIntegerResult offsetResult = editor.GetInteger(new PromptIntegerOptions("\nStart index <0>: ")
        {
            AllowNone = true,
            DefaultValue = 0,
            LowerLimit = 0
        });
        if (offsetResult.Status is not (PromptStatus.OK or PromptStatus.None)) return;

        PromptIntegerResult limitResult = editor.GetInteger(new PromptIntegerOptions("\nMaximum objects <20>: ")
        {
            AllowNone = true,
            DefaultValue = 20,
            LowerLimit = 1,
            UpperLimit = 200
        });
        if (limitResult.Status is not (PromptStatus.OK or PromptStatus.None)) return;

        int offset = offsetResult.Status == PromptStatus.None ? 0 : offsetResult.Value;
        int limit = limitResult.Status == PromptStatus.None ? 20 : limitResult.Value;
        Run(doc => DrawingQueries.GetObjects(doc, offset, limit));
    }

    private static void Run<T>(Func<Document, T> query)
    {
        Document? document = App.DocumentManager.MdiActiveDocument;
        if (document is null) return;

        try
        {
            T result = query(document);
            document.Editor.WriteMessage("\n" + JsonSerializer.Serialize(result, JsonOptions) + "\n");
        }
        catch (System.Exception ex)
        {
            document.Editor.WriteMessage($"\nMyCivil3DMcp query failed: {ex.Message}\n");
        }
    }
}
