namespace MyCivil3DMcp.Plugin;

public sealed record AlignmentOverview(AlignmentSummary Alignment, AlignmentSettings Settings,
    IReadOnlyDictionary<string, int> Sections, IReadOnlyList<string> Unavailable);
