namespace MyCivil3DMcp.Plugin;

/// <summary>
/// An alignment planned by the Node service from a polyline: its IPs from start to end and
/// the curve at each inner IP (Curves[i] belongs to Points[i + 1]; no radius leaves an angle point).
/// Polyline holds the vertices the plan was made from, so a moved polyline is not used.
/// Description records the alignment's uses ("용도: 도로, 관망").
/// </summary>
public sealed record AlignmentCreateRequest(string Name, string Type, PlannedPolyline Polyline,
    IReadOnlyList<PlannedPoint> Points, IReadOnlyList<PlannedCurve> Curves, double? DesignSpeed, string? Description);

public sealed record PlannedPolyline(string Handle, IReadOnlyList<PlannedVertex> Vertices);

public sealed record PlannedVertex(double X, double Y, double Bulge);

public sealed record PlannedPoint(double X, double Y);

public sealed record PlannedCurve(double? Radius, double? SpiralLength);
