namespace MyCivil3DMcp.Plugin;

public sealed record DrawingObjectDetail(string Handle, string Type, string DxfName, string Layer,
    object? Geometry, double[]? BoundsMin, double[]? BoundsMax);
