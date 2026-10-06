using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;
using Surface = Autodesk.Civil.DatabaseServices.Surface;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// The whole drawing in one read: every Model Space object counted by type and by layer,
/// and the Civil objects people ask about (alignments, profiles, surfaces, pipe networks
/// with their pipe and structure counts, corridors, sites and parcels, COGO points).
/// One call replaces paging through layers and objects. Parts Civil 3D cannot provide are
/// listed under Unavailable instead of failing the whole summary.
/// </summary>
internal static class DrawingSummary
{
    private const int MaxTypes = 30;
    private const int MaxLayers = 25;
    private const int MaxNamed = 40;

    public static DrawingSummaryInfo Read(Document document)
    {
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();
        List<string> unavailable = new();
        T? Try<T>(string part, Func<T> read)
        {
            try { return read(); }
            catch (System.Exception ex) { unavailable.Add($"{part}: {ex.Message}"); return default; }
        }

        Dictionary<string, int> byType = new(), byLayer = new();
        int total = 0;
        BlockTableRecord modelSpace = (BlockTableRecord)transaction.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(database), OpenMode.ForRead);
        foreach (ObjectId id in modelSpace)
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;
            total++;
            string type = entity.GetType().Name;
            byType[type] = byType.GetValueOrDefault(type) + 1;
            byLayer[entity.Layer] = byLayer.GetValueOrDefault(entity.Layer) + 1;
        }

        CivilDocument? civil = CivilApplication.ActiveDocument;
        List<Alignment> alignments = Try("alignments", () => AlignmentQueries.AllAlignments(transaction)) ?? new();
        int profiles = alignments.Sum(alignment => Try("profiles", () => alignment.GetProfileIds().Count));
        Dictionary<string, int> alignmentTypes = alignments.GroupBy(alignment => alignment.AlignmentType.ToString())
            .ToDictionary(group => group.Key, group => group.Count());

        List<NamedCount> surfaces = civil is null ? new() : Try("surfaces", () => civil.GetSurfaceIds().Cast<ObjectId>()
            .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Surface>()
            .Select(surface => new NamedCount(surface.Name, surface.GetType().Name, null, null)).ToList()) ?? new();
        List<NamedCount> networks = civil is null ? new() : Try("pipe_networks", () => civil.GetPipeNetworkIds().Cast<ObjectId>()
            .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Network>()
            .Select(network => new NamedCount(network.Name, "PipeNetwork", network.GetPipeIds().Count, network.GetStructureIds().Count)).ToList()) ?? new();
        List<NamedCount> corridors = civil is null ? new() : Try("corridors", () => civil.CorridorCollection.Cast<ObjectId>()
            .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Corridor>()
            .Select(corridor => new NamedCount(corridor.Name, "Corridor", corridor.Baselines.Count, null)).ToList()) ?? new();
        List<NamedCount> sites = civil is null ? new() : Try("sites", () => civil.GetSiteIds().Cast<ObjectId>()
            .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Site>()
            .Select(site => new NamedCount(site.Name, "Site", site.GetParcelIds().Count, site.GetAlignmentIds().Count)).ToList()) ?? new();
        int cogoPoints = civil is null ? 0 : Try("cogo_points", () => (int)civil.CogoPoints.Count);

        return new DrawingSummaryInfo(document.Name, total,
            Top(byType, MaxTypes), byType.Count, Top(byLayer, MaxLayers), byLayer.Count,
            new CivilCounts(alignments.Count, alignmentTypes, profiles, cogoPoints,
                Limit(surfaces), surfaces.Count, Limit(networks), networks.Count,
                Limit(corridors), corridors.Count, Limit(sites), sites.Count),
            unavailable);
    }

    private static List<SelectionGroup> Top(Dictionary<string, int> counts, int max) =>
        counts.OrderByDescending(pair => pair.Value).ThenBy(pair => pair.Key).Take(max)
            .Select(pair => new SelectionGroup(pair.Key, pair.Value)).ToList();

    private static List<NamedCount> Limit(List<NamedCount> items) => items.Take(MaxNamed).ToList();
}
