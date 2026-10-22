namespace MyCivil3DMcp.Plugin;

public sealed record AlignmentRelated(IReadOnlyList<ProfileSummary> Profiles, int ProfileViewCount,
    IReadOnlyList<string> SampleLineGroups, IReadOnlyList<string> ChildOffsetAlignments);
