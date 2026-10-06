using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Read-only queries for alignments. An alignment is answered
/// as an overview first and then section by section, so one answer stays small.
/// </summary>
public static class AlignmentQueries
{

    public static AlignmentPage ListAlignments(Document document, int offset = 0, int limit = 50)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<AlignmentSummary> items = AllAlignments(transaction).Select(item => Summarize(transaction, item)).ToList();
        items.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));
        return new AlignmentPage(document.Name, offset, limit, items.Count, items.Skip(offset).Take(limit).ToArray());
    }

    public static AlignmentOverview GetAlignment(Document document, string key)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        return Snapshot(document, transaction, ResolveAlignment(transaction, key)).Overview;
    }

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

    // Snapshots are reused until the drawing changes, so paging through sections
    // does not read the alignment again.
    private static readonly Dictionary<string, (string Revision, AlignmentSnapshot Snapshot)> Snapshots = new();

    private static AlignmentSnapshot Snapshot(Document document, Transaction transaction, Alignment alignment)
    {
        string key = $"{document.Database.Filename}|{alignment.Handle}";
        string revision = DrawingRevisions.Of(document.Database);
        if (Snapshots.TryGetValue(key, out var cached) && cached.Revision == revision) return cached.Snapshot;
        AlignmentSnapshot snapshot = AlignmentSnapshot.Read(transaction, alignment);
        if (Snapshots.Count > 50) Snapshots.Clear();
        Snapshots[key] = (revision, snapshot);
        return snapshot;
    }

    // Alignments can sit in sites or be siteless; both sets are merged without duplicates.
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
