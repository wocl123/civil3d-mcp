namespace MyCivil3DMcp.Plugin;

/// <summary>The drawing's current selection: how many objects, and up to 20 of them.</summary>
public sealed record SelectionPage(string DrawingName, int TotalCount, IReadOnlyList<SelectedObject> Items);

/// <summary>One selected object; Civil objects carry their name, 2D polylines their summary.</summary>
public sealed record SelectedObject(string Handle, string Type, string Layer, string? Name, PolylineSummary? Polyline);
