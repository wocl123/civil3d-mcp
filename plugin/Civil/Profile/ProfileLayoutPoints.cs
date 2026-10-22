using System.Text.Json.Nodes;

namespace MyCivil3DMcp.Plugin;

// API 호출 전에 측점 순서·곡선 겹침을 확인한다. 곡선은 내부 PVI의 대칭 포물선이다.
internal static class ProfileLayoutPoints
{
    internal sealed record Point(double Station, double Elevation, double? CurveLength);

    public static IReadOnlyList<Point> Read(JsonNode? node, double start, double end)
    {
        JsonArray array = node as JsonArray ?? throw new ArgumentException("종단 PVI 목록이 필요합니다.");
        if (array.Count is < 2 or > 1000)
        {
            throw new ArgumentException("PVI는 2~1000개여야 합니다.");
        }

        Point[] points = array.Select(item => new Point(Number(item?["station"]), Number(item?["elevation"]),
            item?["curveLength"] is null ? null : Number(item["curveLength"]))).ToArray();
        for (int index = 0; index < points.Length; index++)
        {
            Point point = points[index];
            bool outside = point.Station < start || point.Station > end;
            bool isEndpoint = index == 0 || index == points.Length - 1;
            if (outside || (point.CurveLength.HasValue && (isEndpoint || point.CurveLength.Value <= 0)))
            {
                throw new ArgumentException("PVI는 선형 범위 안에, 양수 길이의 곡선은 내부 PVI에만 지정하세요.");
            }

            if (index == 0)
            {
                continue;
            }

            Point previous = points[index - 1];
            double curveSpace = (previous.CurveLength ?? 0) / 2 + (point.CurveLength ?? 0) / 2;
            double distance = point.Station - previous.Station;
            if (distance <= 0 || curveSpace >= distance)
            {
                throw new ArgumentException("PVI 측점은 증가해야 하며 종단곡선이 서로 겹치면 안 됩니다.");
            }
        }

        return points;
    }

    private static double Number(JsonNode? node)
    {
        double value = node?.GetValue<double>() ?? throw new ArgumentException("PVI 숫자가 필요합니다.");
        if (!double.IsFinite(value))
        {
            throw new ArgumentException("PVI는 유한한 숫자여야 합니다.");
        }

        return value;
    }
}
