namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Node 서비스가 폴리선으로 계획한 선형: 시작부터 끝까지의 IP와, 안쪽 IP마다의 곡선
/// (Curves[i]는 Points[i + 1]의 곡선. 반지름이 없으면 꺾인 점으로 남는다).
/// Polyline에는 계획에 쓴 꼭짓점이 있어, 그 뒤 움직인 폴리선은 쓰지 않는다.
/// Description에는 선형의 용도를 적는다("용도: 도로, 관망").
/// </summary>
public sealed record AlignmentCreateRequest(string Name, string Type, PlannedPolyline Polyline,
    IReadOnlyList<PlannedPoint> Points, IReadOnlyList<PlannedCurve> Curves, double? DesignSpeed, string? Description);

public sealed record PlannedPolyline(string Handle, IReadOnlyList<PlannedVertex> Vertices);

public sealed record PlannedVertex(double X, double Y, double Bulge);

public sealed record PlannedPoint(double X, double Y);

public sealed record PlannedCurve(double? Radius, double? SpiralLength);
