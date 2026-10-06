using System.Runtime.CompilerServices;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace MyCivil3DMcp.Plugin;

/// <summary>Counts object changes per open drawing so the Node service can tell whether a saved answer is still current.</summary>
internal static class DrawingRevisions
{
    private sealed class Counter { public long Value; }

    // A new session prefix keeps counters from different Civil 3D sessions from matching.
    private static readonly string Session = Guid.NewGuid().ToString("N")[..8];
    private static readonly ConditionalWeakTable<Database, Counter> Counters = new();
    private static bool _started;

    public static void Start()
    {
        if (_started) return;
        _started = true;
        foreach (Document document in App.DocumentManager) Track(document.Database);
        App.DocumentManager.DocumentCreated += (_, e) => Track(e.Document.Database);
    }

    public static string Of(Database database) =>
        Counters.TryGetValue(database, out Counter? counter)
            ? $"{Session}-{Interlocked.Read(ref counter.Value)}"
            : $"{Session}-untracked-{Guid.NewGuid():N}";

    private static void Track(Database database)
    {
        if (Counters.TryGetValue(database, out _)) return;
        Counters.Add(database, new Counter());
        database.ObjectAppended += (sender, _) => Changed(sender);
        database.ObjectModified += (sender, _) => Changed(sender);
        database.ObjectErased += (sender, _) => Changed(sender);
    }

    private static void Changed(object? sender)
    {
        if (sender is Database database && Counters.TryGetValue(database, out Counter? counter))
            Interlocked.Increment(ref counter.Value);
    }
}
