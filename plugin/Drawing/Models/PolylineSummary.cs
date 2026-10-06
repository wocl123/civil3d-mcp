namespace MyCivil3DMcp.Plugin;

/// <summary>선형 후보로 보여 줄 2D 폴리선: 어디 있고 어떻게 생겼는지.</summary>
public sealed record PolylineSummary(string Handle, string Layer, int VertexCount, int ArcSegmentCount, bool Closed,
    double Length, double[] Start, double[] End);
