namespace MyCivil3DMcp.Plugin;

/// <summary>
/// drawing.summary: Model Space counted by type and by layer (largest groups first, with the
/// number of distinct types and layers), and the drawing's Civil objects.
/// </summary>
public sealed record DrawingSummaryInfo(string DrawingName, int ObjectCount,
    IReadOnlyList<SelectionGroup> ByType, int TypeCount, IReadOnlyList<SelectionGroup> ByLayer, int LayerCount,
    CivilCounts Civil, IReadOnlyList<string> Unavailable);

/// <summary>
/// Civil objects: counts, and up to 40 named items of each kind. For a pipe network First is
/// the pipe count and Second the structure count; for a corridor First is the baseline count;
/// for a site First is the parcel count and Second the alignment count.
/// </summary>
public sealed record CivilCounts(int Alignments, IReadOnlyDictionary<string, int> AlignmentTypes, int Profiles, int CogoPoints,
    IReadOnlyList<NamedCount> Surfaces, int SurfaceCount, IReadOnlyList<NamedCount> PipeNetworks, int PipeNetworkCount,
    IReadOnlyList<NamedCount> Corridors, int CorridorCount, IReadOnlyList<NamedCount> Sites, int SiteCount);

/// <summary>One named Civil object with up to two counts (see CivilCounts).</summary>
public sealed record NamedCount(string Name, string Type, int? First, int? Second);
