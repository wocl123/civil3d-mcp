namespace MyCivil3DMcp.Plugin;

/// <summary>What the user did at the pick prompt: picked (with the polyline), cancelled, or timeout.</summary>
public sealed record PolylinePick(string Status, PolylineSummary? Polyline);
