namespace MyCivil3DMcp.Plugin;

/// <summary>A PVI; grades are in percent.</summary>
public sealed record ProfilePvi(int Number, double Station, string StationText, double Elevation,
    double? GradeInPercent, double? GradeOutPercent, string CurveType)
{
    public double? GradeChangePercent { get; init; }
    public double? CurveLength { get; init; }
    public double? K { get; init; }
    public string? CrestOrSag { get; init; }
    public double? StoppingSightDistance { get; init; }
    public double? PassingSightDistance { get; init; }
    public double? HeadlightSightDistance { get; init; }
}
