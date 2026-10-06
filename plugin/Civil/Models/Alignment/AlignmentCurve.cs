namespace MyCivil3DMcp.Plugin;

/// <summary>평면곡선 묶음 하나. 완화-원-완화(SCS)도 곡선 하나로 센다.</summary>
public sealed record AlignmentCurve(int Number, string GroupType, double StartStation, double EndStation,
    string StartStationText, string EndStationText, double Length, string? Turn, double? MinRadius,
    double? TotalDeltaDeg, double? SpiralAIn, double? SpiralAOut, int ElementCount);
