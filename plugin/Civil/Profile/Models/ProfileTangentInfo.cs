namespace MyCivil3DMcp.Plugin;

public sealed record ProfileTangentInfo(int Number, double StartStation, double EndStation, string StartStationText,
    string EndStationText, double StartElevation, double EndElevation, double Length, double? GradePercent)
{
    public IReadOnlyList<string>? DesignViolations { get; init; }
}
