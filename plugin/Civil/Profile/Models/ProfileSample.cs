namespace MyCivil3DMcp.Plugin;

/// <summary>한 측점에서 읽은 표고와 경사. 종단 범위 밖이면 null.</summary>
public sealed record ProfileSample(double Station, string StationText, double? Elevation, double? GradePercent);
