namespace MyCivil3DMcp.Plugin;

/// <summary>The created alignment, its curves as read back, and the drawing revision after it.</summary>
public sealed record AlignmentCreateResult(string Name, string Handle, string Type, double Length,
    IReadOnlyList<CreatedCurve> Curves, string Revision);

public sealed record CreatedCurve(int Ip, double Radius, double? SpiralLength);
