using System.Runtime.CompilerServices;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using App = Autodesk.AutoCAD.ApplicationServices.Application;
using CivilEntity = Autodesk.Civil.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 도면마다 지금 선택(그립이 잡힌 객체)을 기억한다. 팔레트 AI는 사용자가 묻기 전에
/// 선택해 둔 것을 쓰고, 다시 고르라고 하지 않는다.
/// 선택이 바뀔 때마다 적어 두는 이유: 브리지 요청은 명령 컨텍스트에서 실행되는데,
/// 그때는 선택이 이미 사라졌을 수 있다.
/// 브리지 요청 자체도 선택을 지운다: 요청이 명령 컨텍스트에 들어가면 AutoCAD가 그립을 지우고,
/// 그러면 "아무것도 선택 안 됨"으로 ImpliedSelectionChanged가 온다.
/// 요청 중(또는 끝난 직후 2초)의 이런 빈 변경은 사용자가 선택을 푼 것이 아니므로 무시한다.
/// 그 밖의 때에 ESC나 빈 곳 클릭은 그대로 선택을 지운다.
/// </summary>
internal static class DrawingSelection
{
    private const int MaxItems = 20;
    private const long BridgeGraceMs = 2000;
    private static readonly ConditionalWeakTable<Document, ObjectId[]> Selected = new();
    private static bool _started;
    private static int _bridgeRequests;
    private static long _bridgeEndedAt;

    // PluginBridge가 명령 컨텍스트에서 실행하는 모든 요청의 앞뒤에서 부른다.
    public static void BridgeStarted() => Interlocked.Increment(ref _bridgeRequests);

    public static void BridgeEnded()
    {
        Interlocked.Exchange(ref _bridgeEndedAt, Environment.TickCount64);
        Interlocked.Decrement(ref _bridgeRequests);
    }

    public static bool BridgeRunning => Volatile.Read(ref _bridgeRequests) > 0;

    // 지금 빈 선택 변경을 무시해야 하는지: 요청 중이거나 끝난 지 2초가 안 됨.
    private static bool BridgeClearing =>
        Volatile.Read(ref _bridgeRequests) > 0 || Environment.TickCount64 - Interlocked.Read(ref _bridgeEndedAt) < BridgeGraceMs;

    public static void Start()
    {
        if (_started) return;
        _started = true;
        foreach (Document document in App.DocumentManager) Track(document);
        App.DocumentManager.DocumentCreated += (_, e) => Track(e.Document);
    }

    private static void Track(Document document) =>
        document.ImpliedSelectionChanged += (_, _) => Record(document);

    // 선택이 바뀌면 객체 id를 적어 둔다.
    private static void Record(Document document)
    {
        ObjectId[] ids;
        try
        {
            PromptSelectionResult result = document.Editor.SelectImplied();
            ids = result.Status == PromptStatus.OK ? result.Value.GetObjectIds() : [];
        }
        catch (System.Exception) { ids = []; }
        if (ids.Length == 0 && BridgeClearing) return;
        Selected.AddOrUpdate(document, ids);
    }

    private const int MaxGroups = 15;

    // 기억한 선택: 모두 종류별·레이어별로 세고(많은 것부터 15개), 앞 20개는 자세히.
    public static SelectionPage Get(Document document)
    {
        ObjectId[] ids = Selected.TryGetValue(document, out ObjectId[]? recorded) ? recorded : [];
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<SelectedObject> items = new();
        Dictionary<string, int> byType = new(), byLayer = new();
        int count = 0;
        foreach (ObjectId id in ids)
        {
            if (!id.IsValid || id.IsErased || id.Database != document.Database) continue;
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;
            count++;
            string type = entity.GetType().Name;
            byType[type] = byType.GetValueOrDefault(type) + 1;
            byLayer[entity.Layer] = byLayer.GetValueOrDefault(entity.Layer) + 1;
            if (items.Count >= MaxItems) continue;
            items.Add(new SelectedObject(entity.Handle.ToString(), type, entity.Layer, NameOf(entity),
                entity is Polyline polyline ? DrawingQueries.Summarize(polyline) : null));
        }
        return new SelectionPage(document.Name, count, Groups(byType), Groups(byLayer), items);
    }

    private static List<SelectionGroup> Groups(Dictionary<string, int> counts) =>
        counts.OrderByDescending(pair => pair.Value).ThenBy(pair => pair.Key).Take(MaxGroups)
            .Select(pair => new SelectionGroup(pair.Key, pair.Value)).ToList();

    // 어떤 Civil 객체(구획 세그먼트 등)는 이름이 없으면 이름을 물을 때 예외를 낸다.
    // 그 때문에 나머지 선택까지 잃으면 안 된다.
    private static string? NameOf(Entity entity)
    {
        if (entity is not CivilEntity civil) return null;
        try { return string.IsNullOrWhiteSpace(civil.Name) ? null : civil.Name; }
        catch (System.Exception) { return null; }
    }
}
