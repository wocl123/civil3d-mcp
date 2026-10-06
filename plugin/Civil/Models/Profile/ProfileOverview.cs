namespace MyCivil3DMcp.Plugin;

/// <summary>Highest and lowest points are found from the entities' end points and curve high or low points.</summary>
public sealed record ProfileOverview(ProfileSummary Profile, ProfileSettings Settings, ProfilePoint? Highest,
    ProfilePoint? Lowest, IReadOnlyDictionary<string, int> Sections, IReadOnlyList<string> Unavailable);
