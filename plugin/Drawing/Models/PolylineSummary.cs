namespace MyCivil3DMcp.Plugin;

/// <summary>A 2D polyline as candidates for an alignment are listed: where it is and how it is built.</summary>
public sealed record PolylineSummary(string Handle, string Layer, int VertexCount, int ArcSegmentCount, bool Closed,
    double Length, double[] Start, double[] End);
