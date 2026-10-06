namespace MyCivil3DMcp.Plugin;

/// <summary>편경사 임계 측점. 차로 경사는 %.</summary>
public sealed record AlignmentSuperelevationStation(string CurveName, double Station, string StationText,
    string Type, string Region)
{
    public string? Description { get; init; }
    public double? LeftOutLanePercent { get; init; }
    public double? LeftInLanePercent { get; init; }
    public double? RightInLanePercent { get; init; }
    public double? RightOutLanePercent { get; init; }
}
