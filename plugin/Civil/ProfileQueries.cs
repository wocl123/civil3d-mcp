using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 종단 조회(읽기만): 먼저 개요, 그다음 구간(section)을 하나씩.
/// 한 번 읽은 스냅숏은 도면이 바뀌기 전까지 다시 쓴다.
/// </summary>
public static class ProfileQueries
{
    private static readonly Dictionary<string, (string Revision, ProfileSnapshot Snapshot)> Snapshots = new();

    // 개요: 요약, 설정, PVI·곡선 개수 등.
    public static ProfileOverview GetProfile(Document document, string key, string? alignmentKey)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        (Alignment alignment, Profile profile) = Resolve(transaction, key, alignmentKey);
        return Snapshot(document, transaction, alignment, profile).Overview;
    }

    // 구간 한 페이지. "elevations"는 측점마다 표고를 계산하고, 나머지는 스냅숏에서 꺼낸다.
    public static ProfileSectionPage GetProfileSection(Document document, string key, string? alignmentKey, string section,
        double? from, double? to, double[] stations, double? interval, int offset = 0, int limit = 50)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        (Alignment alignment, Profile profile) = Resolve(transaction, key, alignmentKey);
        ProfileSnapshot snapshot = Snapshot(document, transaction, alignment, profile);
        List<object> items = section == "elevations"
            ? ProfileSnapshot.Sample(alignment, profile, snapshot.SampleStations(from, to, stations, interval)).ToList()
            : snapshot.Section(section, from, to).ToList();
        return new ProfileSectionPage(profile.Name, profile.Handle.ToString(), alignment.Name, section, from, to,
            offset, limit, items.Count, items.Skip(offset).Take(limit).ToArray());
    }

    // (도면 파일, 종단 핸들)별 스냅숏. 리비전이 같으면 재사용, 50개가 넘으면 비운다.
    private static ProfileSnapshot Snapshot(Document document, Transaction transaction, Alignment alignment, Profile profile)
    {
        string key = $"{DrawingRevisions.Id(document.Database)}|{profile.Handle}";
        string revision = DrawingRevisions.Of(document.Database);
        if (Snapshots.TryGetValue(key, out var cached) && cached.Revision == revision) return cached.Snapshot;
        ProfileSnapshot snapshot = ProfileSnapshot.Read(transaction, alignment, profile);
        if (Snapshots.Count > 50) Snapshots.Clear();
        Snapshots[key] = (revision, snapshot);
        return snapshot;
    }

    // 종단 찾기: 핸들로, 또는 이름으로(주어진 선형 안에서, 없으면 도면 전체에서).
    // 같은 이름이 여럿이면 핸들이나 선형을 달라고 한다.
    internal static (Alignment, Profile) Resolve(Transaction transaction, string key, string? alignmentKey)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("A profile handle or name is required.");
        IEnumerable<Alignment> scope = alignmentKey is null
            ? AlignmentQueries.AllAlignments(transaction) : [AlignmentQueries.ResolveAlignment(transaction, alignmentKey)];
        List<(Alignment, Profile)> profiles = new();
        foreach (Alignment alignment in scope)
            foreach (ObjectId id in alignment.GetProfileIds())
                if (transaction.GetObject(id, OpenMode.ForRead) is Profile profile)
                    profiles.Add((alignment, profile));
        foreach ((Alignment, Profile) item in profiles)
            if (string.Equals(item.Item2.Handle.ToString(), key, StringComparison.OrdinalIgnoreCase)) return item;
        List<(Alignment, Profile)> byName = profiles
            .Where(item => string.Equals(item.Item2.Name, key.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
        return byName.Count switch
        {
            1 => byName[0],
            0 => throw new ArgumentException($"Profile '{key}' was not found."),
            _ => throw new ArgumentException($"Several profiles are named '{key}'. Use a handle or give the alignment: " +
                string.Join(", ", byName.Select(item => $"{item.Item2.Handle} ({item.Item1.Name})")))
        };
    }
}
