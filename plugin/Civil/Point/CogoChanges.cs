using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class CogoChanges
{
    public static object List(Document document, int offset, int limit)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        CogoPoint[] points = CivilDocument.GetCivilDocument(document.Database).CogoPoints
            .Where(id => !id.IsErased).Select(id => (CogoPoint)transaction.GetObject(id, OpenMode.ForRead))
            .OrderBy(point => point.PointNumber).ToArray();
        return new { total = points.Length, offset, items = points.Skip(offset).Take(limit).Select(Info).ToArray(),
            hasMore = offset + limit < points.Length, note = CivilCoordinates.Notice(CivilCoordinates.Read(document.Database)) };
    }

    private static object Info(CogoPoint point) => new
    {
        handle = point.Handle.ToString(), number = point.PointNumber, position = PrimitiveAccess.JsonPoint(point.Location),
        rawDescription = point.RawDescription, layer = point.Layer, style = point.StyleId.Handle.ToString(),
        labelStyle = point.LabelStyleId.Handle.ToString(), locked = point.IsLocked,
        survey = point.IsSurveyPoint, project = point.IsProjectPoint, movable = point.IsMovable
    };

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "cogo.create";
        if (create)
        {
            ValidateCreation(database, request, details);
            PrimitiveAccess.Layer(database, transaction, request);
        }
        else
        {
            ValidateEdit(database, transaction, request, details);
        }

        ValidateStyles(database, transaction, request, details);
        details.Add("COGO 측량점을 다룹니다. 설명키를 자동 적용하지 않으며, 점 그룹의 표시 재지정은 유지합니다.");
        int count = create ? request["points"]!.AsArray().Count : request["handles"]!.AsArray().Count;
        return $"COGO 점 {count}개 {(create ? "생성" : "수정")}";
    }

    private static void ValidateCreation(Database database, JsonObject request, List<string> details)
    {
        JsonArray points = request["points"] as JsonArray ?? throw new ArgumentException("점 목록이 필요합니다.");
        if (points.Count is < 1 or > 1000)
        {
            throw new ArgumentException("COGO 점은 1~1000개 지정하세요.");
        }

        CogoPointCollection existing = CivilDocument.GetCivilDocument(database).CogoPoints;
        HashSet<uint> numbers = new();
        foreach (JsonNode? item in points)
        {
            uint number = PointNumber(item?["number"]);
            if (!numbers.Add(number) || existing.Contains(number))
            {
                throw new ArgumentException($"점번호 {number}가 중복됩니다. 다른 번호를 지정하세요.");
            }

            Point3d position = PrimitiveAccess.Point(item?["position"]);
            Description(item?["rawDescription"]);
            details.Add($"점 {number}: {PrimitiveAccess.PointText(position)}, 원시 설명 '{item?["rawDescription"]}'");
        }
    }

    private static void ValidateEdit(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        CogoPoint[] points = PrimitiveAccess.Targets<CogoPoint>(database, transaction, request).Cast<CogoPoint>().ToArray();
        int positions = new[] { "position", "moveBy", "elevation" }.Count(key => request[key] is not null);
        bool singleOnly = request["position"] is not null || request["number"] is not null;
        if (positions > 1 || (singleOnly && points.Length != 1))
        {
            throw new ArgumentException("위치·이동·표고 중 하나만 쓰세요. 절대 위치와 점번호는 한 점에만 지정합니다.");
        }

        bool changes = new[] { "position", "moveBy", "elevation", "number", "rawDescription", "style", "labelStyle", "layer" }
            .Any(key => request[key] is not null);
        if (!changes)
        {
            throw new ArgumentException("변경할 COGO 점 속성을 지정하세요.");
        }

        foreach (CogoPoint point in points)
        {
            bool protectedPoint = point.IsLocked || point.IsSurveyPoint || point.IsProjectPoint || !point.IsMovable;
            if (protectedPoint)
            {
                throw new ArgumentException($"점 {point.PointNumber}는 잠금·측량 DB·프로젝트 또는 이동 불가 점입니다.");
            }

            Point3d after = Position(point.Location, request);
            details.Add($"점 {point.PointNumber} [{point.Handle}]: {PrimitiveAccess.PointText(point.Location)} → {PrimitiveAccess.PointText(after)}");
        }

        request["targetState"] = JsonSerializer.SerializeToNode(points.Select(Info).ToArray());
        ValidateNumber(database, points[0], request, details);
        Description(request["rawDescription"]);
        if (request["rawDescription"] is not null)
        {
            details.Add($"원시 설명을 '{request["rawDescription"]}'로 변경합니다.");
        }

        if (request["layer"] is not null)
        {
            PrimitiveAccess.Layer(database, transaction, request);
            details.Add($"레이어 → {request["layer"]}");
        }
    }

    private static void ValidateNumber(Database database, CogoPoint point, JsonObject request, List<string> details)
    {
        if (request["number"] is null)
        {
            return;
        }

        uint number = PointNumber(request["number"]);
        if (number != point.PointNumber && CivilDocument.GetCivilDocument(database).CogoPoints.Contains(number))
        {
            throw new ArgumentException($"점번호 {number}가 이미 있습니다. 기존 점을 덮어쓰지 않습니다.");
        }

        details.Add($"점번호: {point.PointNumber} → {number}");
    }

    private static uint PointNumber(JsonNode? node)
    {
        double value = CivilObjectAccess.Number(node);
        if (value < 1 || value > uint.MaxValue - 1 || value != Math.Truncate(value))
        {
            throw new ArgumentException("점번호는 1~4294967294 정수여야 합니다.");
        }

        return (uint)value;
    }

    private static void Description(JsonNode? node)
    {
        if (node is not null && node.GetValue<string>().Length > 1000)
        {
            throw new ArgumentException("원시 설명은 1000자 이하로 주세요.");
        }
    }

    private static void ValidateStyles(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        foreach (var (key, kind) in new[] { ("style", "point"), ("labelStyle", "pointLabel") })
        {
            if (request[key] is null)
            {
                continue;
            }

            ObjectId id = CivilObjectAccess.Style(transaction, database, kind, request[key]!.ToString());
            request[key] = id.Handle.ToString();
            details.Add($"{key}: {((Autodesk.Civil.DatabaseServices.Styles.StyleBase)transaction.GetObject(id, OpenMode.ForRead)).Name}");
        }
    }

    private static Point3d Position(Point3d before, JsonObject request)
    {
        if (request["position"] is not null)
        {
            return PrimitiveAccess.Point(request["position"]);
        }

        if (request["moveBy"] is not null)
        {
            return before + (PrimitiveAccess.Point(request["moveBy"]) - Point3d.Origin);
        }

        return request["elevation"] is null ? before
            : new Point3d(before.X, before.Y, CivilObjectAccess.Number(request["elevation"]));
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        CogoPointCollection collection = CivilDocument.GetCivilDocument(database).CogoPoints;
        List<CogoPoint> points = new();
        bool create = CivilObjectAccess.Text(request, "operation") == "cogo.create";
        if (create)
        {
            foreach (JsonNode? item in request["points"]!.AsArray())
            {
                ObjectId id = collection.Add(PrimitiveAccess.Point(item!["position"]),
                    item["rawDescription"]?.GetValue<string>() ?? "", false, false, false);
                CogoPoint point = (CogoPoint)transaction.GetObject(id, OpenMode.ForWrite);
                point.PointNumber = PointNumber(item["number"]);
                points.Add(point);
            }
        }
        else
        {
            foreach (JsonNode? handle in request["handles"]!.AsArray())
            {
                var point = (CogoPoint)CivilObjectAccess.ByHandle(transaction, database, handle!.GetValue<string>());
                points.Add((CogoPoint)transaction.GetObject(point.ObjectId, OpenMode.ForWrite));
            }
        }

        foreach (CogoPoint point in points)
        {
            ApplyProperties(database, transaction, point, request);
        }

        return new { points = points.Select(Info).ToArray() };
    }

    private static void ApplyProperties(Database database, Transaction transaction, CogoPoint point, JsonObject request)
    {
        Point3d after = Position(point.Location, request);
        point.Easting = after.X;
        point.Northing = after.Y;
        point.Elevation = after.Z;
        if (request["number"] is not null)
        {
            point.PointNumber = PointNumber(request["number"]);
        }

        if (request["rawDescription"] is not null)
        {
            point.RawDescription = CivilObjectAccess.Text(request, "rawDescription");
        }

        if (request["layer"] is not null)
        {
            point.LayerId = CivilObjectAccess.Layer(transaction, database, request["layer"]!.ToString());
        }

        if (request["style"] is not null)
        {
            point.StyleId = CivilObjectAccess.Style(transaction, database, "point", request["style"]!.ToString());
        }

        if (request["labelStyle"] is not null)
        {
            point.LabelStyleId = CivilObjectAccess.Style(transaction, database, "pointLabel", request["labelStyle"]!.ToString());
        }

        if (point.Location.DistanceTo(after) > 1e-7)
        {
            throw new InvalidOperationException("Civil 3D의 COGO 점 위치가 요청과 달라 전체 작업을 취소했습니다.");
        }
    }
}
