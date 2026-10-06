namespace MyCivil3DMcp.Plugin;

public sealed record ProfileSummary(string Name, string Handle, string Type, string Layer,
    double StartStation, double EndStation, string StartStationText, string EndStationText,
    double? MinElevation, double? MaxElevation)
{
    public string? Description { get; init; }
    public string? Style { get; init; }
    public string? AlignmentName { get; init; }
    public string? AlignmentHandle { get; init; }
}
