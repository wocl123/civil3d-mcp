using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

// 기본 도형(선·폴리선·직사각형·원·호) 그리기와 삭제. 좌표는 WCS 도면 단위, 한 XY 평면 위에 만든다.
internal static class GeometryChanges
{
    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "geometry.delete")
        {
            Entity[] targets = PrimitiveAccess.Targets<Curve>(database, transaction, request);
            if (targets.Any(entity => entity is not (Line or Polyline or Circle or Arc)))
            {
                throw new ArgumentException("선·폴리선·원·호만 이 도구로 삭제합니다. Civil 객체는 전용 삭제 도구를 쓰세요.");
            }

            PrimitiveAccess.AddItems(details, targets.Select(entity =>
                $"{Kind(entity)} [{entity.Handle}] · 레이어 {entity.Layer}").ToArray());
            return $"도형 {targets.Length}개 삭제";
        }

        PrimitiveAccess.Layer(database, transaction, request);
        using Entity shape = Create(request);
        details.Add($"{Kind(shape)} · 레이어 {request["layer"]}");
        details.AddRange(Describe(shape));
        return $"{Kind(shape)} 1개 그리기";
    }

    private static string Kind(Entity entity) => entity switch
    {
        Line => "선",
        Polyline polyline when polyline.Closed && polyline.NumberOfVertices == 4 && IsRectangle(polyline) => "직사각형",
        Polyline polyline => polyline.Closed ? "닫힌 폴리선" : "폴리선",
        Circle => "원",
        Arc => "호",
        _ => entity.GetType().Name
    };

    private static bool IsRectangle(Polyline polyline)
    {
        Point3d[] corners = Enumerable.Range(0, 4).Select(polyline.GetPoint3dAt).ToArray();
        return Enumerable.Range(0, 4).All(index =>
        {
            Vector3d first = corners[(index + 1) % 4] - corners[index];
            Vector3d second = corners[(index + 2) % 4] - corners[(index + 1) % 4];
            return Math.Abs(first.GetNormal().DotProduct(second.GetNormal())) < 1e-9;
        });
    }

    private static IEnumerable<string> Describe(Entity shape)
    {
        switch (shape)
        {
            case Line line:
                yield return $"시작 {PrimitiveAccess.PointText(line.StartPoint)} → 끝 {PrimitiveAccess.PointText(line.EndPoint)}";
                yield return $"길이 {PrimitiveAccess.Number(line.Length)}";
                break;
            case Polyline polyline:
                Point3d[] vertices = Enumerable.Range(0, polyline.NumberOfVertices).Select(polyline.GetPoint3dAt).ToArray();
                foreach (string text in vertices.Take(20).Select((point, index) =>
                    $"꼭짓점 {index + 1}: {PrimitiveAccess.PointText(point)}"))
                {
                    yield return text;
                }

                if (vertices.Length > 20)
                {
                    yield return $"외 꼭짓점 {vertices.Length - 20}개";
                }

                yield return $"길이 {PrimitiveAccess.Number(polyline.Length)}"
                    + (polyline.Closed ? $" · 면적 {PrimitiveAccess.Number(polyline.Area)}" : "");
                break;
            case Circle circle:
                yield return $"중심 {PrimitiveAccess.PointText(circle.Center)} · 반지름 {PrimitiveAccess.Number(circle.Radius)}";
                break;
            case Arc arc:
                yield return $"중심 {PrimitiveAccess.PointText(arc.Center)} · 반지름 {PrimitiveAccess.Number(arc.Radius)}";
                yield return $"시작각 {PrimitiveAccess.Number(arc.StartAngle * 180 / Math.PI)}° → "
                    + $"끝각 {PrimitiveAccess.Number(arc.EndAngle * 180 / Math.PI)}° (반시계)";
                break;
        }
    }

    private static Entity Create(JsonObject request)
    {
        string kind = CivilObjectAccess.Text(request, "kind");
        if (kind is "circle" or "arc")
        {
            Point3d center = PrimitiveAccess.Point(request["center"]);
            double radius = CivilObjectAccess.Number(request["radius"]);
            if (radius <= 0)
            {
                throw new ArgumentException("반지름은 0보다 커야 합니다.");
            }

            if (kind == "circle")
            {
                return new Circle(center, Vector3d.ZAxis, radius);
            }

            double start = CivilObjectAccess.Number(request["startAngleDegrees"]) * Math.PI / 180;
            double end = CivilObjectAccess.Number(request["endAngleDegrees"]) * Math.PI / 180;
            if (Math.Abs(start - end) < 1e-9)
            {
                throw new ArgumentException("호의 시작각과 끝각이 같습니다.");
            }

            return new Arc(center, radius, start, end);
        }

        Point3d[] points = Points(request, kind);
        if (kind == "line")
        {
            return new Line(points[0], points[1]);
        }

        bool closed = kind == "rectangle" || request["closed"]?.GetValue<bool>() == true;
        Polyline polyline = new() { Elevation = points[0].Z, Closed = closed };
        foreach (Point3d point in points)
        {
            polyline.AddVertexAt(polyline.NumberOfVertices, new Point2d(point.X, point.Y), 0, 0, 0);
        }

        return polyline;
    }

    private static Point3d[] Points(JsonObject request, string kind)
    {
        JsonArray input = request["points"] as JsonArray ?? throw new ArgumentException("좌표 points가 필요합니다.");
        Point3d[] points = input.Select(PrimitiveAccess.Point).ToArray();
        if (points.Any(point => Math.Abs(point.Z - points[0].Z) > 1e-9))
        {
            throw new ArgumentException("모든 좌표의 Z를 같게 주세요. 도형은 한 XY 평면에 그립니다.");
        }

        if (kind == "rectangle")
        {
            points = Rectangle(request, points);
        }
        else if (kind is not ("line" or "polyline"))
        {
            throw new ArgumentException("지원하는 도형: line, polyline, rectangle, circle, arc");
        }

        bool counted = kind == "line" ? points.Length == 2 : points.Length is >= 2 and <= 1000;
        bool repeated = points.Zip(points.Skip(1)).Any(pair => pair.First.DistanceTo(pair.Second) <= 1e-9);
        if (!counted || repeated)
        {
            throw new ArgumentException("선은 점 2개, 폴리선은 2~1000개이며 이어지는 두 점이 겹치면 안 됩니다.");
        }

        return points;
    }

    // 마주 보는 두 모서리, 또는 한 모서리 + width/height(음수면 반대 방향). WCS 축에 나란하다.
    private static Point3d[] Rectangle(JsonObject request, Point3d[] points)
    {
        bool sized = request["width"] is not null || request["height"] is not null;
        Point3d first = points[0];
        Point3d opposite = sized && points.Length == 1
            ? first + new Vector3d(CivilObjectAccess.Number(request["width"]), CivilObjectAccess.Number(request["height"]), 0)
            : !sized && points.Length == 2 ? points[1]
            : throw new ArgumentException("직사각형은 마주 보는 두 모서리 또는 한 모서리와 width·height를 주세요.");
        if (Math.Abs(opposite.X - first.X) <= 1e-9 || Math.Abs(opposite.Y - first.Y) <= 1e-9)
        {
            throw new ArgumentException("직사각형의 가로와 세로는 0이 아니어야 합니다.");
        }

        request["points"] = new JsonArray(PrimitiveAccess.JsonPoint(first), PrimitiveAccess.JsonPoint(opposite));
        request.Remove("width");
        request.Remove("height");
        return [first, new Point3d(opposite.X, first.Y, first.Z), opposite, new Point3d(first.X, opposite.Y, first.Z)];
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        if (CivilObjectAccess.Text(request, "operation") == "geometry.delete")
        {
            return new { deleted = PrimitiveAccess.Erase(database, transaction, request) };
        }

        using Entity shape = Create(request);
        shape.SetDatabaseDefaults(database);
        shape.LayerId = PrimitiveAccess.Layer(database, transaction, request);
        return new { created = new[] { PrimitiveAccess.Append(database, transaction, shape).Handle.ToString() } };
    }
}
