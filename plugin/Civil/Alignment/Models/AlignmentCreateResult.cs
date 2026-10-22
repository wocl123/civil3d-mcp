namespace MyCivil3DMcp.Plugin;

/// <summary>만든 선형, 다시 읽은 곡선, 만든 뒤의 도면 리비전.</summary>
public sealed record AlignmentCreateResult(string Name, string Handle, string Type, double Length,
    IReadOnlyList<CreatedCurve> Curves, string Revision);

public sealed record CreatedCurve(int Ip, double Radius, double? SpiralLength);
