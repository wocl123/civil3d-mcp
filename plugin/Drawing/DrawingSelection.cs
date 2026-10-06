using System.Runtime.CompilerServices;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using App = Autodesk.AutoCAD.ApplicationServices.Application;
using CivilEntity = Autodesk.Civil.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Keeps each drawing's current selection (the objects with grips), so the palette AI can
/// use what the user selected before asking instead of prompting for a pick. The set is
/// recorded when it changes, because a bridge request runs in a command context where
/// the implied selection may already be gone.
/// A bridge request itself clears the selection: AutoCAD drops the grips when the request
/// enters a command context, and that raises ImpliedSelectionChanged with nothing selected.
/// Such an empty change while a request runs (or just after) is not the user deselecting,
/// so it is ignored; ESC or a click on empty space at any other time still clears the set.
/// </summary>
internal static class DrawingSelection
{
    private const int MaxItems = 20;
    private const long BridgeGraceMs = 2000;
    private static readonly ConditionalWeakTable<Document, ObjectId[]> Selected = new();
    private static bool _started;
    private static int _bridgeRequests;
    private static long _bridgeEndedAt;

    // Called by PluginBridge around every request that runs in a command context.
    public static void BridgeStarted() => Interlocked.Increment(ref _bridgeRequests);

    public static void BridgeEnded()
    {
        Interlocked.Exchange(ref _bridgeEndedAt, Environment.TickCount64);
        Interlocked.Decrement(ref _bridgeRequests);
    }

    public static bool BridgeRunning => Volatile.Read(ref _bridgeRequests) > 0;

    // After an AI answer: the requests it made dropped the user's grips, so they are shown
    // again on what the user had selected, as long as the user has not selected anything since.
    public static void RestoreGrips()
    {
        Document? document = App.DocumentManager.MdiActiveDocument;
        if (document is null || !Selected.TryGetValue(document, out ObjectId[]? ids)) return;
        ObjectId[] valid = ids.Where(id => id.IsValid && !id.IsErased && id.Database == document.Database).ToArray();
        if (valid.Length == 0) return;
        try
        {
            PromptSelectionResult current = document.Editor.SelectImplied();
            if (current.Status == PromptStatus.OK && current.Value.Count > 0) return;
            document.Editor.SetImpliedSelection(valid);
        }
        catch (System.Exception) { /* Grips are only a view; the recorded selection stays. */ }
    }

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

    // Some Civil objects (parcel segments, for one) throw when asked for a name they do not
    // have; that must not lose the rest of the selection.
    private static string? NameOf(Entity entity)
    {
        if (entity is not CivilEntity civil) return null;
        try { return string.IsNullOrWhiteSpace(civil.Name) ? null : civil.Name; }
        catch (System.Exception) { return null; }
    }
}
