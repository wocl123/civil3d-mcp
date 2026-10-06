namespace MyCivil3DMcp.Plugin;

public sealed record DrawingLayerPage(string DrawingName, int Offset, int Limit, int TotalCount,
    IReadOnlyList<DrawingLayer> Items);
