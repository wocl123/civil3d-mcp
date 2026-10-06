namespace MyCivil3DMcp.Plugin;

public sealed record PolylinePage(string DrawingName, int Offset, int Limit, int TotalCount, IReadOnlyList<PolylineSummary> Items);
