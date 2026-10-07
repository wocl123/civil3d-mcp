using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace MyCivil3DMcp.Plugin;

/// <summary>열린 도면마다 고유 ID와 객체 변경 횟수를 둔다. Node 서비스는 이 값으로 저장한 답과 수정안이 아직 맞는지 판단한다.</summary>
// 리비전 = "<세션>-<횟수>". 도면 객체(Entity: 선, 폴리선, 선형, 종단 등)가 추가·수정·삭제될 때마다 1씩 오른다.
// 뷰포트·사전·Xrecord 같은 비도면 객체의 변경은 세지 않는다: 화면 이동이나 명령 실행만으로도
// AutoCAD가 이런 객체를 고쳐, 읽기만 했는데 리비전이 올라 수정안이 "도면이 바뀜"으로 거절되었다.
// 도면은 네이티브 포인터(UnmanagedObject)로 구별한다. document.Database가 돌려주는 .NET 래퍼는
// 부를 때마다 다른 객체일 수 있어, 래퍼를 키로 쓰면 같은 도면을 매번 처음 보는 도면으로 여겼다
// (리비전이 "untracked-<무작위>"가 되어 모든 조회가 "도면이 바뀜"으로 실패).
internal static class DrawingRevisions
{
    // 파일 이름은 같은 도면을 다시 열거나 미저장 도면을 구별하지 못한다.
    private sealed class Counter { public readonly string Id = Guid.NewGuid().ToString("N"); public long Value; }

    // 최근 변경(진단용, MYC3DREVISIONS 명령으로 본다).
    public sealed record Change(DateTime At, string Event, string Type, string Handle, bool Counted, bool DuringBridge);
    private const int MaxRecent = 40;
    private static readonly Queue<Change> Recent = new();

    // Civil 3D를 새로 켜면 세션 앞자리가 바뀌어, 이전 세션의 같은 횟수와 섞이지 않는다.
    private static readonly string Session = Guid.NewGuid().ToString("N")[..8];
    private static readonly Dictionary<IntPtr, Counter> Counters = new();
    private static readonly object Gate = new();
    private static bool _started;

    public static void Start()
    {
        if (_started) return;
        _started = true;
        foreach (Document document in App.DocumentManager) Track(document.Database);
        App.DocumentManager.DocumentCreated += (_, e) => Track(e.Document.Database);
        // 닫힌 도면의 포인터를 다음에 여는 도면이 다시 쓸 수 있으므로 닫을 때 지운다.
        App.DocumentManager.DocumentToBeDestroyed += (_, e) => Forget(e.Document.Database);
    }

    public static string Of(Database database) => $"{Session}-{Interlocked.Read(ref Track(database).Value)}";

    public static string Id(Database database) => Track(database).Id;

    public static IReadOnlyList<Change> RecentChanges()
    {
        lock (Gate) return Recent.ToList();
    }

    // 기록기: 만든 때부터 Dispose 할 때까지의 모든 객체 변경을 모은다.
    // 도면 작업이 시작~끝까지 무엇을 바꿨는지, UNDO 한 단계가 무엇을 되돌렸는지 알아내는 데 쓴다.
    public sealed class Recorder(IntPtr database) : IDisposable
    {
        internal readonly IntPtr Database = database;
        private readonly List<Change> _changes = new();
        public IReadOnlyList<Change> Changes { get { lock (Gate) return _changes.ToList(); } }
        internal void Add(Change change) => _changes.Add(change);
        public void Dispose() { lock (Gate) Recorders.Remove(this); }
    }
    private static readonly List<Recorder> Recorders = new();

    public static Recorder Record(Database database)
    {
        Track(database);
        Recorder recorder = new(database.UnmanagedObject);
        lock (Gate) Recorders.Add(recorder);
        return recorder;
    }

    // 처음 보는 도면이면 세기 시작한다(이벤트는 도면마다 한 번만 단다).
    private static Counter Track(Database database)
    {
        lock (Gate)
        {
            if (Counters.TryGetValue(database.UnmanagedObject, out Counter? counter)) return counter;
            counter = new Counter();
            Counters[database.UnmanagedObject] = counter;
            database.ObjectAppended += (sender, e) => Changed(sender, "추가", e.DBObject);
            database.ObjectModified += (sender, e) => Changed(sender, "수정", e.DBObject);
            database.ObjectErased += (sender, e) => Changed(sender, e.Erased ? "삭제" : "삭제 취소", e.DBObject);
            return counter;
        }
    }

    private static void Forget(Database database)
    {
        lock (Gate) Counters.Remove(database.UnmanagedObject);
    }

    private static void Changed(object? sender, string kind, DBObject? item)
    {
        if (sender is not Database database) return;
        bool counted = item is Entity;
        string type = "?", handle = "";
        try
        {
            type = item?.GetType().Name ?? "?";
            handle = item?.Handle.ToString() ?? "";
        }
        catch (System.Exception) { }

        lock (Gate)
        {
            Change change = new(DateTime.Now, kind, type, handle, counted, DrawingSelection.BridgeRunning);
            Recent.Enqueue(change);
            while (Recent.Count > MaxRecent) Recent.Dequeue();
            foreach (Recorder recorder in Recorders)
                if (recorder.Database == database.UnmanagedObject) recorder.Add(change);
            if (counted && Counters.TryGetValue(database.UnmanagedObject, out Counter? counter)) counter.Value++;
        }
    }
}
