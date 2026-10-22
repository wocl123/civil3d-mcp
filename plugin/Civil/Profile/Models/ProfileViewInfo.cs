namespace MyCivil3DMcp.Plugin;

public sealed record ProfileViewInfo(string Name, string Handle, double StartStation, double EndStation,
    string StartStationText, string EndStationText, double MinElevation, double MaxElevation)
{
    public string? Style { get; init; }
}
