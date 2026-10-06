namespace MyCivil3DMcp.Plugin;

/// <summary>모형 공간을 그린 그림: PNG(base64), 보이는 범위 [minX, minY, maxX, maxY], 맞춘 객체.</summary>
public sealed record DrawingImage(int Width, int Height, string Png, double[] Area, IReadOnlyList<string> Framed);
