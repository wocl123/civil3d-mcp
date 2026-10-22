using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

// 객체를 교체하지 않고 핸들을 유지한다. 회전·축척은 명시한 WCS 기준점에서 수행한다.
internal static class GeometryEditing
{
    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        Entity[] targets = PrimitiveAccess.Targets<Curve>(database, transaction, request);
        if (targets.Any(entity => entity is not (Line or Polyline or Circle or Arc)))
        {
            throw new ArgumentException("일반 선·폴리선·원·호만 수정합니다. Civil 객체는 전용 도구를 쓰세요.");
        }

        if (!new[] { "moveBy", "rotationDegrees", "scale", "layer", "color", "radius" }
            .Any(key => request[key] is not null))
        {
            throw new ArgumentException("변경할 형상 또는 속성을 지정하세요.");
        }

        if (request["layer"] is not null)
        {
            PrimitiveAccess.Layer(database, transaction, request);
        }

        if (request["color"] is not null && request["color"]!.GetValue<int>() is < 0 or > 256)
        {
            throw new ArgumentException("ACI 색상은 0~256입니다.");
        }

        if (request["radius"] is not null && (CivilObjectAccess.Number(request["radius"]) <= 0
            || targets.Any(entity => entity is not (Circle or Arc))))
        {
            throw new ArgumentException("반지름은 원·호에만 지정하며 0보다 커야 합니다.");
        }

        request["targetState"] = new JsonArray(targets.Select(Snapshot).ToArray());
        Matrix3d transform = Transform(request);
        foreach (Entity entity in targets)
        {
            // 실제 객체를 바꾸지 않고 같은 API로 변환 가능 여부를 확인한다.
            using Entity copy = (Entity)entity.Clone();
            Edit(copy, request, transform);
            details.Add($"{entity.GetType().Name} [{entity.Handle}] 레이어 {entity.Layer} → {request["layer"]?.ToString() ?? entity.Layer}");
        }
        if (request["moveBy"] is not null)
        {
            details.Add($"WCS 이동: {PrimitiveAccess.PointText(PrimitiveAccess.Point(request["moveBy"]))}");
        }

        if (request["radius"] is not null)
        {
            details.Add($"반지름 설정: {request["radius"]} (축척 적용 전)");
        }

        if (request["rotationDegrees"] is not null || request["scale"] is not null)
        {
            details.Add($"기준점 {PrimitiveAccess.PointText(PrimitiveAccess.Point(request["basePoint"]))}, Z축 회전 {request["rotationDegrees"]?.ToString() ?? "0"}°, 균일 축척 {request["scale"]?.ToString() ?? "1"}");
        }

        if (request["color"] is not null)
        {
            details.Add($"색상 ACI {request["color"]} (0=ByBlock, 256=ByLayer)");
        }

        details.Add("반지름 설정 → 축척 → 회전 → 이동 순서로 적용하며 원래 핸들을 유지합니다.");
        return $"도형 {targets.Length}개 수정";
    }

    private static Matrix3d Transform(JsonObject request)
    {
        bool aboutPoint = request["scale"] is not null || request["rotationDegrees"] is not null;
        if (!aboutPoint && request["basePoint"] is not null)
        {
            throw new ArgumentException("기준점은 회전 또는 축척과 함께 지정하세요.");
        }

        Point3d origin = aboutPoint ? PrimitiveAccess.Point(request["basePoint"]) : Point3d.Origin;
        double scale = request["scale"] is null ? 1 : CivilObjectAccess.Number(request["scale"]);
        if (scale <= 0)
        {
            throw new ArgumentException("축척은 0보다 커야 합니다.");
        }

        double angle = request["rotationDegrees"] is null ? 0 : CivilObjectAccess.Number(request["rotationDegrees"]) * Math.PI / 180;
        Vector3d move = request["moveBy"] is null ? new Vector3d(0, 0, 0) : PrimitiveAccess.Point(request["moveBy"]) - Point3d.Origin;
        return Matrix3d.Displacement(move) * Matrix3d.Rotation(angle, Vector3d.ZAxis, origin)
            * Matrix3d.Scaling(scale, origin);
    }

    private static void Edit(Entity entity, JsonObject request, Matrix3d transform)
    {
        if (request["radius"] is not null)
        {
            double radius = CivilObjectAccess.Number(request["radius"]);
            if (entity is Circle circle)
            {
                circle.Radius = radius;
            }
            else if (entity is Arc arc)
            {
                arc.Radius = radius;
            }
        }
        entity.TransformBy(transform);
        if (request["color"] is not null)
        {
            entity.ColorIndex = request["color"]!.GetValue<int>();
        }
    }

    internal static JsonNode Snapshot(Entity entity)
    {
        JsonObject state = new() { ["handle"] = entity.Handle.ToString(), ["layer"] = entity.Layer,
            ["color"] = entity.Color.ToString(), ["linetype"] = entity.Linetype, ["lineweight"] = (int)entity.LineWeight };
        switch (entity)
        {
            case Line line:
                state["start"] = PrimitiveAccess.JsonPoint(line.StartPoint);
                state["end"] = PrimitiveAccess.JsonPoint(line.EndPoint);
                break;
            case Polyline polyline:
                state["closed"] = polyline.Closed;
                state["normal"] = PrimitiveAccess.JsonPoint(Point3d.Origin + polyline.Normal);
                state["vertices"] = new JsonArray(Enumerable.Range(0, polyline.NumberOfVertices).Select(index =>
                    (JsonNode)new JsonObject { ["point"] = PrimitiveAccess.JsonPoint(polyline.GetPoint3dAt(index)),
                        ["bulge"] = polyline.GetBulgeAt(index), ["startWidth"] = polyline.GetStartWidthAt(index),
                        ["endWidth"] = polyline.GetEndWidthAt(index) }).ToArray());
                break;
            case Circle circle:
                state["center"] = PrimitiveAccess.JsonPoint(circle.Center);
                state["radius"] = circle.Radius;
                state["normal"] = PrimitiveAccess.JsonPoint(Point3d.Origin + circle.Normal);
                break;
            case Arc arc:
                state["center"] = PrimitiveAccess.JsonPoint(arc.Center);
                state["radius"] = arc.Radius;
                state["normal"] = PrimitiveAccess.JsonPoint(Point3d.Origin + arc.Normal);
                state["start"] = arc.StartAngle;
                state["end"] = arc.EndAngle;
                break;
        }
        return state;
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        Matrix3d transform = Transform(request);
        string[] handles = request["handles"]!.AsArray().Select(node => node!.GetValue<string>()).ToArray();
        foreach (string handle in handles)
        {
            Entity source = CivilObjectAccess.ByHandle(transaction, database, handle);
            Entity entity = (Entity)transaction.GetObject(source.ObjectId, OpenMode.ForWrite);
            Edit(entity, request, transform);
            if (request["layer"] is not null)
            {
                entity.LayerId = CivilObjectAccess.Layer(transaction, database, request["layer"]!.ToString());
            }
        }
        return new { changed = handles };
    }
}
