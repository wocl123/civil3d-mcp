using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Read-only queries for profiles: an overview first, then one section at a time.
/// Snapshots are reused until the drawing changes.
/// </summary>
public static class ProfileQueries
{
    private static readonly Dictionary<string, (string Revision, ProfileSnapshot Snapshot)> Snapshots = new();

    public static ProfileOverview GetProfile(Document document, string key, string? alignmentKey)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        (Alignment alignment, Profile profile) = Resolve(transaction, key, alignmentKey);
        return Snapshot(document, transaction, alignment, profile).Overview;
    }

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

    private static ProfileSnapshot Snapshot(Document document, Transaction transaction, Alignment alignment, Profile profile)
    {
        string key = $"{document.Database.Filename}|{profile.Handle}";
        string revision = DrawingRevisions.Of(document.Database);
        if (Snapshots.TryGetValue(key, out var cached) && cached.Revision == revision) return cached.Snapshot;
        ProfileSnapshot snapshot = ProfileSnapshot.Read(transaction, alignment, profile);
        if (Snapshots.Count > 50) Snapshots.Clear();
        Snapshots[key] = (revision, snapshot);
        return snapshot;
    }

    // A profile is found by handle, or by name within the given alignment or the whole drawing.
    private static (Alignment, Profile) Resolve(Transaction transaction, string key, string? alignmentKey)
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
