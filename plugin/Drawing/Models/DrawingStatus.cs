namespace MyCivil3DMcp.Plugin;

public sealed record DrawingStatus(
    string DrawingName,
    string FilePath,
    string AutoCadVersion,
    bool CivilDocumentAvailable,
    int ModelSpaceObjectCount)
{
    public string? DrawingUnits { get; init; }
    public string? CoordinateSystem { get; init; }
    public string? DrawingId { get; init; }
    public int ProtocolVersion { get; init; } = 2;
    public string? Revision { get; init; }
}
