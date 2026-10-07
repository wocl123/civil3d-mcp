using System.Text.Json;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Runtime;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

[assembly: CommandClass(typeof(MyCivil3DMcp.Plugin.PluginEntry))]
[assembly: ExtensionApplication(typeof(MyCivil3DMcp.Plugin.PluginEntry))]

namespace MyCivil3DMcp.Plugin;

// 플러그인 시작점. NETLOAD 하면 Initialize가 불리고, Civil 3D가 닫힐 때 Terminate가 불린다.
// 명령:
//   MYC3DCHAT        AI 팔레트 열기
//   MYC3DCONNECTION  브리지·Node 서비스 연결 상태
//   MYC3DSTATUS      도면 상태(JSON)
//   MYC3DOBJECTS     도면 객체 목록(JSON, 시작 번호·개수를 물음)
public sealed class PluginEntry : IExtensionApplication
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    // 도면 리비전·선택 추적 → 브리지(Node가 플러그인을 부르는 통로) → Node 서비스 순서로 시작한다.
    public void Initialize()
    {
        try
        {
            DrawingRevisions.Start();
            DrawingSelection.Start();
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

    // 진단: 지금 리비전과 최근 객체 변경(무엇이 리비전을 올렸는지).
    [CommandMethod("MYC3DREVISIONS")]
    public void ShowRevisions()
    {
        Document? document = App.DocumentManager.MdiActiveDocument;
        if (document is null) return;
        Editor editor = document.Editor;
        editor.WriteMessage($"\n리비전 {DrawingRevisions.Of(document.Database)} (도면 ID {DrawingRevisions.Id(document.Database)[..8]})");
        editor.WriteMessage("\n최근 객체 변경 (센 것 = 리비전을 올림, 브리지 = AI 조회·변경 중):");
        foreach (DrawingRevisions.Change change in DrawingRevisions.RecentChanges())
            editor.WriteMessage($"\n  {change.At:HH:mm:ss} {change.Event} {change.Type} [{change.Handle}]" +
                (change.Counted ? " 센 것" : "") + (change.DuringBridge ? " 브리지" : ""));
        editor.WriteMessage("\n");
    }

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

    // 조회 결과를 명령줄에 JSON으로 찍는다.
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
