namespace MyCivil3DMcp.Plugin;

/// <summary>A superelevation critical station; lane slopes are in percent.</summary>
public sealed record AlignmentSuperelevationStation(string CurveName, double Station, string StationText,
    string Type, string Region)
{
    public string? Description { get; init; }
    public double? LeftOutLanePercent { get; init; }
    public double? LeftInLanePercent { get; init; }
    public double? RightInLanePercent { get; init; }
    public double? RightOutLanePercent { get; init; }
}
