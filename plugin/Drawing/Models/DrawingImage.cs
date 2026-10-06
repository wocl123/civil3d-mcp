namespace MyCivil3DMcp.Plugin;

/// <summary>A rendered view of Model Space: a PNG (base64), the area it shows [minX, minY, maxX, maxY], and the objects it was framed on.</summary>
public sealed record DrawingImage(int Width, int Height, string Png, double[] Area, IReadOnlyList<string> Framed);
