namespace MyCivil3DMcp.Plugin;

/// <summary>
/// drawing.summary: 모형 공간을 종류별·레이어별로 센 것(많은 것부터, 서로 다른 종류·레이어 수와 함께)과
/// 도면의 Civil 객체.
/// </summary>
public sealed record DrawingSummaryInfo(string DrawingName, int ObjectCount,
    IReadOnlyList<SelectionGroup> ByType, int TypeCount, IReadOnlyList<SelectionGroup> ByLayer, int LayerCount,
    CivilCounts Civil, IReadOnlyList<string> Unavailable);

/// <summary>
/// Civil 객체: 개수와 종류마다 이름 있는 항목 40개까지.
/// 관망: First = 관 수, Second = 구조물 수 / 코리더: First = 기준선 수 /
/// 부지: First = 구획 수, Second = 선형 수.
/// </summary>
public sealed record CivilCounts(int Alignments, IReadOnlyDictionary<string, int> AlignmentTypes, int Profiles, int CogoPoints,
    IReadOnlyList<NamedCount> Surfaces, int SurfaceCount, IReadOnlyList<NamedCount> PipeNetworks, int PipeNetworkCount,
    IReadOnlyList<NamedCount> Corridors, int CorridorCount, IReadOnlyList<NamedCount> Sites, int SiteCount);

/// <summary>이름 있는 Civil 객체 하나와 개수 두 개까지(CivilCounts 참고).</summary>
public sealed record NamedCount(string Name, string Type, int? First, int? Second);
