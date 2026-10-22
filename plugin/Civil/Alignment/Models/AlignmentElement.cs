namespace MyCivil3DMcp.Plugin;

/// <summary>직선·원곡선·완화곡선 하나(측점 순서). 각도는 도(°).</summary>
public sealed record AlignmentElement(int Order, int CurveGroup, string Kind, string GroupType,
    double StartStation, double EndStation, string StartStationText, string EndStationText, double Length,
    double[] StartPoint, double[] EndPoint)
{
    public double? AzimuthDeg { get; init; }
    public double? Radius { get; init; }
    public string? Turn { get; init; }
    public double? DeltaDeg { get; init; }
    public double? Tangent { get; init; }
    public double? External { get; init; }
    public double? MidOrdinate { get; init; }
    public double? Chord { get; init; }
    public double[]? Center { get; init; }
    public double[]? PiPoint { get; init; }
    public string? PiStationText { get; init; }
    public bool? Reverse { get; init; }
    public double? SpiralA { get; init; }
    public double? RadiusIn { get; init; }
    public double? RadiusOut { get; init; }
    public string? SpiralDefinition { get; init; }
    public string? SpiralInOut { get; init; }
    public double? SpiralK { get; init; }
    public double? SpiralP { get; init; }
    public double? LongTangent { get; init; }
    public double? ShortTangent { get; init; }
    public IReadOnlyList<string>? DesignViolations { get; init; }
}
