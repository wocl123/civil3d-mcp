namespace MyCivil3DMcp.Plugin;

/// <summary>종단 개요. 최고·최저점은 요소 끝점과 곡선의 최고·최저점에서 구한다.</summary>
public sealed record ProfileOverview(ProfileSummary Profile, ProfileSettings Settings, ProfilePoint? Highest,
    ProfilePoint? Lowest, IReadOnlyDictionary<string, int> Sections, IReadOnlyList<string> Unavailable);
