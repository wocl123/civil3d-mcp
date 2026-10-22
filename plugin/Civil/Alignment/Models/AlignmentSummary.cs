namespace MyCivil3DMcp.Plugin;

public sealed record AlignmentSummary(string Name, string Handle, string Type, string Layer,
    double StartStation, double EndStation, double Length, string StartStationText, string EndStationText,
    int ProfileCount)
{
    public string? Site { get; init; }
    public string? Description { get; init; }
    public string? Style { get; init; }
    public bool IsOffset { get; init; }
}
