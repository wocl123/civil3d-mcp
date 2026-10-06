namespace MyCivil3DMcp.Plugin;

/// <summary>One horizontal curve group, such as spiral-curve-spiral, counted as one curve.</summary>
public sealed record AlignmentCurve(int Number, string GroupType, double StartStation, double EndStation,
    string StartStationText, string EndStationText, double Length, string? Turn, double? MinRadius,
    double? TotalDeltaDeg, double? SpiralAIn, double? SpiralAOut, int ElementCount);
