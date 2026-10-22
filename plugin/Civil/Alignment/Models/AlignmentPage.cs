namespace MyCivil3DMcp.Plugin;

public sealed record AlignmentPage(string DrawingName, int Offset, int Limit, int TotalCount,
    IReadOnlyList<AlignmentSummary> Items);
