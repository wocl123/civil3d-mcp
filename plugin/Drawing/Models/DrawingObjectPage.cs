namespace MyCivil3DMcp.Plugin;

public sealed record DrawingObjectPage(
    string DrawingName,
    int Offset,
    int Limit,
    int TotalCount,
    IReadOnlyList<DrawingObject> Items);
