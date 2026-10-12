using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;
using Surface = Autodesk.Civil.DatabaseServices.Surface;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 도면 전체를 한 번에 읽는다: 모형 공간의 모든 객체를 종류별·레이어별로 세고,
/// 자주 묻는 Civil 객체(선형, 종단, 지표면, 관망과 관·구조물 수, 코리더, 부지와 구획, COGO 점)를 센다.
/// 레이어·객체 목록을 여러 번 넘겨 보는 호출을 이 한 번으로 대신한다.
/// Civil 3D가 주지 못하는 부분은 요약 전체를 실패시키지 않고 Unavailable에 적는다.
/// </summary>
internal static class DrawingSummary
{
    private const int MaxTypes = 30;
    private const int MaxLayers = 25;
    private const int MaxNamed = 40;

    // 종류·레이어는 많은 것부터 30·25개, 이름 있는 Civil 객체는 종류마다 40개까지.
    public static DrawingSummaryInfo Read(Document document)
    {
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();

        // 한 부분이 실패하면 그 이유만 적고 계속한다.
        List<string> unavailable = new();
        T? Try<T>(string part, Func<T> read)
        {
            try
            {
                return read();
            }
            catch (System.Exception ex)
            {
                unavailable.Add($"{part}: {ex.Message}");
                return default;
            }
        }

        // ── 모형 공간 객체 세기
        Dictionary<string, int> byType = new();
        Dictionary<string, int> byLayer = new();
        int total = 0;

        BlockTableRecord modelSpace = (BlockTableRecord)transaction.GetObject(
            SymbolUtilityServices.GetBlockModelSpaceId(database), OpenMode.ForRead);

        foreach (ObjectId id in modelSpace)
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity)
            {
                continue;
            }

            total++;
            string type = entity.GetType().Name;
            byType[type] = byType.GetValueOrDefault(type) + 1;
            byLayer[entity.Layer] = byLayer.GetValueOrDefault(entity.Layer) + 1;
        }

        // ── Civil 객체
        CivilDocument? civil = CivilApplication.ActiveDocument;

        List<Alignment> alignments = Try("alignments", () => AlignmentQueries.AllAlignments(transaction)) ?? new();
        int profiles = alignments.Sum(alignment => Try("profiles", () => alignment.GetProfileIds().Count));
        Dictionary<string, int> alignmentTypes = alignments
            .GroupBy(alignment => alignment.AlignmentType.ToString())
            .ToDictionary(group => group.Key, group => group.Count());

        List<NamedCount> surfaces = new();
        List<NamedCount> networks = new();
        List<NamedCount> corridors = new();
        List<NamedCount> sites = new();
        int cogoPoints = 0;

        if (civil is not null)
        {
            surfaces = Try("surfaces", () => ReadSurfaces(transaction, civil)) ?? new();
            networks = Try("pipe_networks", () => ReadNetworks(transaction, civil)) ?? new();
            corridors = Try("corridors", () => ReadCorridors(transaction, civil)) ?? new();
            sites = Try("sites", () => ReadSites(transaction, civil)) ?? new();
            cogoPoints = Try("cogo_points", () => (int)civil.CogoPoints.Count);
        }

        CivilCounts civilCounts = new(
            alignments.Count, alignmentTypes, profiles, cogoPoints,
            Limit(surfaces), surfaces.Count, Limit(networks), networks.Count,
            Limit(corridors), corridors.Count, Limit(sites), sites.Count);

        return new DrawingSummaryInfo(
            document.Name, total,
            Top(byType, MaxTypes), byType.Count, Top(byLayer, MaxLayers), byLayer.Count,
            civilCounts, unavailable);
    }

    private static List<NamedCount> ReadSurfaces(Transaction transaction, CivilDocument civil)
    {
        return Open<Surface>(transaction, civil.GetSurfaceIds().Cast<ObjectId>())
            .Select(surface => new NamedCount(surface.Name, surface.GetType().Name, null, null))
            .ToList();
    }

    // 관망: 관 수, 구조물 수.
    private static List<NamedCount> ReadNetworks(Transaction transaction, CivilDocument civil)
    {
        return Open<Network>(transaction, civil.GetPipeNetworkIds().Cast<ObjectId>())
            .Select(network => new NamedCount(
                network.Name, "PipeNetwork", network.GetPipeIds().Count, network.GetStructureIds().Count))
            .ToList();
    }

    // 코리더: 기준선 수.
    private static List<NamedCount> ReadCorridors(Transaction transaction, CivilDocument civil)
    {
        return Open<Corridor>(transaction, civil.CorridorCollection.Cast<ObjectId>())
            .Select(corridor => new NamedCount(corridor.Name, "Corridor", corridor.Baselines.Count, null))
            .ToList();
    }

    // 부지: 구획 수, 선형 수.
    private static List<NamedCount> ReadSites(Transaction transaction, CivilDocument civil)
    {
        return Open<Site>(transaction, civil.GetSiteIds().Cast<ObjectId>())
            .Select(site => new NamedCount(
                site.Name, "Site", site.GetParcelIds().Count, site.GetAlignmentIds().Count))
            .ToList();
    }

    private static IEnumerable<T> Open<T>(Transaction transaction, IEnumerable<ObjectId> ids) =>
        ids.Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<T>();

    // 많은 것부터 max개.
    private static List<SelectionGroup> Top(Dictionary<string, int> counts, int max)
    {
        return counts
            .OrderByDescending(pair => pair.Value)
            .ThenBy(pair => pair.Key)
            .Take(max)
            .Select(pair => new SelectionGroup(pair.Key, pair.Value))
            .ToList();
    }

    private static List<NamedCount> Limit(List<NamedCount> items) => items.Take(MaxNamed).ToList();
}
