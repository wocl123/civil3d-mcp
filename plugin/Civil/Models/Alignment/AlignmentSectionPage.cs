namespace MyCivil3DMcp.Plugin;

public sealed record AlignmentSectionPage(string AlignmentName, string AlignmentHandle, string Section,
    double? FromStation, double? ToStation, int Offset, int Limit, int TotalCount, IReadOnlyList<object> Items);
