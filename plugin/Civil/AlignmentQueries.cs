using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 선형 조회(읽기만). 선형 하나는 먼저 개요, 그다음 구간(section)별로 답해
/// 한 번의 답이 작게 유지되게 한다.
/// </summary>
public static class AlignmentQueries
{
    // 선형 목록(이름순).
    public static AlignmentPage ListAlignments(Document document, int offset = 0, int limit = 50)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<AlignmentSummary> items = AllAlignments(transaction).Select(item => Summarize(transaction, item)).ToList();
        items.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));
        return new AlignmentPage(document.Name, offset, limit, items.Count, items.Skip(offset).Take(limit).ToArray());
    }

    // 개요.
    public static AlignmentOverview GetAlignment(Document document, string key)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        return Snapshot(document, transaction, ResolveAlignment(transaction, key)).Overview;
    }

    // 구간 한 페이지(요소, 곡선, 설계속도, 편경사 등).
    public static AlignmentSectionPage GetAlignmentSection(Document document, string key, string section,
        double? from, double? to, int offset = 0, int limit = 50)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Alignment alignment = ResolveAlignment(transaction, key);
        List<object> items = Snapshot(document, transaction, alignment).Section(section, from, to).ToList();
        return new AlignmentSectionPage(alignment.Name, alignment.Handle.ToString(), section, from, to,
            offset, limit, items.Count, items.Skip(offset).Take(limit).ToArray());
    }

    // 스냅숏은 도면이 바뀌기 전까지 재사용한다. 구간을 넘겨 볼 때 선형을 다시 읽지 않게.
    private static readonly Dictionary<string, (string Revision, AlignmentSnapshot Snapshot)> Snapshots = new();

    private static AlignmentSnapshot Snapshot(Document document, Transaction transaction, Alignment alignment)
    {
        string key = $"{DrawingRevisions.Id(document.Database)}|{alignment.Handle}";
        string revision = DrawingRevisions.Of(document.Database);
        if (Snapshots.TryGetValue(key, out var cached) && cached.Revision == revision) return cached.Snapshot;
        AlignmentSnapshot snapshot = AlignmentSnapshot.Read(transaction, alignment);
        if (Snapshots.Count > 50) Snapshots.Clear();
        Snapshots[key] = (revision, snapshot);
        return snapshot;
    }

    // 선형은 부지(site) 안에 있거나 부지 없이 있을 수 있다. 둘을 중복 없이 합친다.
    internal static List<Alignment> AllAlignments(Transaction transaction)
    {
        CivilDocument civil = CivilApplication.ActiveDocument
            ?? throw new InvalidOperationException("Civil 3D document is unavailable.");
        HashSet<ObjectId> ids = new();
        foreach (ObjectId id in civil.GetAlignmentIds()) ids.Add(id);
        foreach (ObjectId id in civil.GetSitelessAlignmentIds()) ids.Add(id);
        foreach (ObjectId siteId in civil.GetSiteIds())
            if (transaction.GetObject(siteId, OpenMode.ForRead) is Site site)
                foreach (ObjectId id in site.GetAlignmentIds()) ids.Add(id);
        return ids.Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Alignment>().ToList();
    }

    // 선형 찾기: 핸들로, 아니면 이름으로. 같은 이름이 여럿이면 핸들을 달라고 한다.
    internal static Alignment ResolveAlignment(Transaction transaction, string key)
    {
        if (string.IsNullOrWhiteSpace(key)) throw new ArgumentException("An alignment handle or name is required.");
        List<Alignment> all = AllAlignments(transaction);
        Alignment? byHandle = all.FirstOrDefault(item => string.Equals(item.Handle.ToString(), key, StringComparison.OrdinalIgnoreCase));
        if (byHandle is not null) return byHandle;
        List<Alignment> byName = all.Where(item => string.Equals(item.Name, key.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();
        return byName.Count switch
        {
            1 => byName[0],
            0 => throw new ArgumentException($"Alignment '{key}' was not found."),
            _ => throw new ArgumentException($"Several alignments are named '{key}'. Use a handle: " +
                string.Join(", ", byName.Select(item => item.Handle.ToString())))
        };
    }

    // 선형 요약 한 줄.
    internal static AlignmentSummary Summarize(Transaction transaction, Alignment alignment)
    {
        string? site = null;
        if (!alignment.SiteId.IsNull && transaction.GetObject(alignment.SiteId, OpenMode.ForRead) is Site owner)
            site = owner.Name;
        return new AlignmentSummary(alignment.Name, alignment.Handle.ToString(), alignment.AlignmentType.ToString(),
            alignment.Layer, Round(alignment.StartingStation), Round(alignment.EndingStation), Round(alignment.Length),
            StationText(alignment, alignment.StartingStation), StationText(alignment, alignment.EndingStation),
            alignment.GetProfileIds().Count)
        {
            Site = site,
            Description = string.IsNullOrWhiteSpace(alignment.Description) ? null : alignment.Description,
            Style = alignment.StyleName,
            IsOffset = alignment.IsOffsetAlignment
        };
    }

    // 종단 요약 한 줄. 최저·최고 표고는 못 구하면 비운다.
    internal static ProfileSummary SummarizeProfile(Alignment alignment, Profile profile)
    {
        double? min = null, max = null;
        try
        {
            min = Finite(profile.ElevationMin);
            max = Finite(profile.ElevationMax);
        }
        catch (System.Exception) { }
        return new ProfileSummary(profile.Name, profile.Handle.ToString(), profile.ProfileType.ToString(), profile.Layer,
            Round(profile.StartingStation), Round(profile.EndingStation),
            StationText(alignment, profile.StartingStation), StationText(alignment, profile.EndingStation), min, max)
        {
            Description = string.IsNullOrWhiteSpace(profile.Description) ? null : profile.Description,
            Style = profile.StyleName,
            AlignmentName = alignment.Name,
            AlignmentHandle = alignment.Handle.ToString()
        };
    }

    private static string StationText(Alignment alignment, double station) => AlignmentSnapshot.StationText(alignment, station);

    private static double? Finite(double value) => AlignmentSnapshot.Finite(value);
    private static double Round(double value) => AlignmentSnapshot.Round(value);
}
