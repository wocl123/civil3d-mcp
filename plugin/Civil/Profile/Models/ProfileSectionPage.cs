namespace MyCivil3DMcp.Plugin;

public sealed record ProfileSectionPage(string ProfileName, string ProfileHandle, string AlignmentName, string Section,
    double? FromStation, double? ToStation, int Offset, int Limit, int TotalCount, IReadOnlyList<object> Items);
