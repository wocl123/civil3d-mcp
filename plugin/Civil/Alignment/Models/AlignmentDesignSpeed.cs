namespace MyCivil3DMcp.Plugin;

public sealed record AlignmentDesignSpeed(double Station, string StationText, double Speed)
{
    public string? Comment { get; init; }
}
