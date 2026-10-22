namespace MyCivil3DMcp.Plugin;

/// <summary>종단곡선과 Civil 3D가 계산한 값. 경사는 %.</summary>
public sealed record ProfileCurveInfo(int Number, string CurveType, string CrestOrSag, double StartStation,
    double EndStation, string StartStationText, string EndStationText, double Length,
    double PviStation, string PviStationText, double PviElevation,
    double? GradeInPercent, double? GradeOutPercent, double? GradeChangePercent, double? K)
{
    public double? Radius { get; init; }
    public double? MiddleOrdinate { get; init; }
    public double? TangentOffsetAtPvi { get; init; }
    public ProfilePoint? HighLowPoint { get; init; }
    public double? AsymmetricLength1 { get; init; }
    public double? AsymmetricLength2 { get; init; }
    public double? MinimumKStopping { get; init; }
    public double? MinimumKPassing { get; init; }
    public double? MinimumKHeadlight { get; init; }
    public double? HighestDesignSpeed { get; init; }
    public IReadOnlyList<string>? DesignViolations { get; init; }
}
