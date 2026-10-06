using System.Runtime.CompilerServices;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace MyCivil3DMcp.Plugin;

/// <summary>열린 도면마다 객체 변경 횟수를 센다. Node 서비스는 이 값으로 저장한 답이 아직 맞는지 판단한다.</summary>
// 리비전 = "<세션>-<횟수>". 객체가 추가·수정·삭제될 때마다 1씩 오른다.
internal static class DrawingRevisions
{
    private sealed class Counter { public long Value; }

    // Civil 3D를 새로 켜면 세션 앞자리가 바뀌어, 이전 세션의 같은 횟수와 섞이지 않는다.
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

    // 추적하지 않는 도면이면 매번 다른 값(→ 저장한 답을 쓰지 않음).
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
