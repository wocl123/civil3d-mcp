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
/// </summary>
internal static class DrawingSelection
{
    private const int MaxItems = 20;
    private static readonly ConditionalWeakTable<Document, ObjectId[]> Selected = new();
    private static bool _started;

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
        try
        {
            PromptSelectionResult result = document.Editor.SelectImplied();
            Selected.AddOrUpdate(document, result.Status == PromptStatus.OK ? result.Value.GetObjectIds() : []);
        }
        catch (System.Exception) { Selected.AddOrUpdate(document, []); }
    }

    public static SelectionPage Get(Document document)
    {
        ObjectId[] ids = Selected.TryGetValue(document, out ObjectId[]? recorded) ? recorded : [];
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<SelectedObject> items = new();
        int count = 0;
        foreach (ObjectId id in ids)
        {
            if (!id.IsValid || id.IsErased || id.Database != document.Database) continue;
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;
            count++;
            if (items.Count >= MaxItems) continue;
            items.Add(new SelectedObject(entity.Handle.ToString(), entity.GetType().Name, entity.Layer,
                entity is CivilEntity civil ? civil.Name : null,
                entity is Polyline polyline ? DrawingQueries.Summarize(polyline) : null));
        }
        return new SelectionPage(document.Name, count, items);
    }
}
