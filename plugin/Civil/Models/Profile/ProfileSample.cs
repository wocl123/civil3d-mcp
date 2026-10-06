namespace MyCivil3DMcp.Plugin;

/// <summary>Elevation and grade read from the profile at one station; null outside its range.</summary>
public sealed record ProfileSample(double Station, string StationText, double? Elevation, double? GradePercent);
