namespace MyCivil3DMcp.Plugin;

/// <summary>
/// The drawing's current selection: how many objects, every one counted by type and by
/// layer (largest groups first), and up to 20 of them in detail.
/// </summary>
public sealed record SelectionPage(string DrawingName, int TotalCount, IReadOnlyList<SelectionGroup> ByType,
    IReadOnlyList<SelectionGroup> ByLayer, IReadOnlyList<SelectedObject> Items);

/// <summary>How many selected objects share a type or a layer.</summary>
public sealed record SelectionGroup(string Name, int Count);

/// <summary>One selected object; Civil objects carry their name, 2D polylines their summary.</summary>
public sealed record SelectedObject(string Handle, string Type, string Layer, string? Name, PolylineSummary? Polyline);
