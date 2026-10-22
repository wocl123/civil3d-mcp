using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

// AutoCAD POINT 객체. 측량/설계용 COGO 점과 TIN 정점은 이 경로에서 변경하지 않는다.
internal static class PointChanges
{
    public static object List(Document document, int offset, int limit)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        DBPoint[] points = PrimitiveAccess.Entities(document.Database, transaction, true).OfType<DBPoint>().ToArray();
        return new { totalCount = points.Length, offset, items = points.Skip(offset).Take(limit).Select(Info).ToArray() };
    }

    private static object Info(DBPoint point) => new
    {
        handle = point.Handle.ToString(), point.Layer, position = PrimitiveAccess.DisplayPoint(point.Position)
    };

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "point.create")
        {
            PrimitiveAccess.Layer(database, transaction, request);
            Point3d[] points = Positions(database, transaction, request);
            request["points"] = new JsonArray(points.Select(point => (JsonNode)PrimitiveAccess.JsonPoint(point)).ToArray());
            request.Remove("verticesOf");
            details.Add($"AutoCAD POINT {points.Length}개, 레이어 {request["layer"]}. COGO 점·TIN 정점은 만들지 않습니다.");
            details.Add("도면의 점 표시 모양/크기(PDMODE/PDSIZE)는 바꾸지 않습니다.");
            PrimitiveAccess.AddItems(details, points.Select((point, index) =>
                $"점 {index + 1}: {PrimitiveAccess.PointText(point)}").ToArray());
            return $"점 {points.Length}개 생성";
        }

        Entity[] targets = PrimitiveAccess.Targets<DBPoint>(database, transaction, request);
        if (operation == "point.edit")
        {
            ValidateEdit(database, transaction, request, targets.Length);
        }

        PrimitiveAccess.AddItems(details, targets.Cast<DBPoint>()
            .Select(point => $"점 [{point.Handle}] · 레이어 {point.Layer} · {PrimitiveAccess.PointText(point.Position)}")
            .ToArray());
        return $"AutoCAD 점 {targets.Length}개 " + (operation == "point.delete" ? "삭제" : "수정");
    }

    private static Point3d[] Positions(Database database, Transaction transaction, JsonObject request)
    {
        bool coordinates = request["points"] is not null;
        bool vertices = request["verticesOf"] is not null;
        if (coordinates == vertices)
        {
            throw new ArgumentException("XYZ 좌표 또는 꼭짓점을 읽을 객체 핸들 중 하나를 지정하세요.");
        }

        IEnumerable<Point3d> positions = coordinates
            ? SurfaceChanges.Points(request["points"], 1, 1000).Cast<Point3d>()
            : ((JsonArray)request["verticesOf"]!).SelectMany(node => Vertices(database, transaction, node!.GetValue<string>()));
        Point3d[] points = positions.Distinct().Take(1001).ToArray();
        if (points.Length is < 1 or > 1000)
        {
            throw new ArgumentException("점은 중복 좌표를 합쳐 1~1000개여야 합니다.");
        }

        return points;
    }

    private static IEnumerable<Point3d> Vertices(Database database, Transaction transaction, string handle)
    {
        Entity entity = CivilObjectAccess.ByHandle(transaction, database, handle);
        BlockTableRecord owner = (BlockTableRecord)transaction.GetObject(entity.OwnerId, OpenMode.ForRead);
        if (!owner.IsLayout || owner.IsFromExternalReference)
        {
            throw new ArgumentException("블록 정의·외부참조의 좌표를 점으로 변환하지 않습니다.");
        }

        if (entity is Polyline polyline)
        {
            return Enumerable.Range(0, polyline.NumberOfVertices).Select(polyline.GetPoint3dAt).ToArray();
        }

        if (entity is Polyline2d line2d)
        {
            return line2d.Cast<ObjectId>().Select(id => (Vertex2d)transaction.GetObject(id, OpenMode.ForRead))
                .Select(line2d.VertexPosition).ToArray();
        }

        if (entity is Polyline3d line3d)
        {
            return line3d.Cast<ObjectId>().Select(id => ((PolylineVertex3d)transaction.GetObject(id, OpenMode.ForRead)).Position)
                .ToArray();
        }

        if (entity is Line line)
        {
            return [line.StartPoint, line.EndPoint];
        }

        throw new ArgumentException($"[{handle}]의 꼭짓점 추출은 지원하지 않습니다. LINE 또는 2D/3D 폴리선을 지정하세요.");
    }

    private static void ValidateEdit(Database database, Transaction transaction, JsonObject request, int count)
    {
        bool position = request["position"] is not null;
        bool move = request["moveBy"] is not null;
        if (position && (move || count != 1))
        {
            throw new ArgumentException("절대 좌표 변경은 점 1개에만 사용하고 상대 이동과 함께 지정하지 마세요.");
        }

        if (!position && !move && request["layer"] is null)
        {
            throw new ArgumentException("점의 새 좌표·이동량 또는 레이어를 지정하세요.");
        }

        if (position || move)
        {
            PrimitiveAccess.Point(request[position ? "position" : "moveBy"]);
        }

        if (request["layer"] is not null)
        {
            PrimitiveAccess.Layer(database, transaction, request);
        }
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "point.delete")
        {
            return new { deleted = PrimitiveAccess.Erase(database, transaction, request) };
        }

        if (operation == "point.create")
        {
            List<string> handles = new();
            foreach (JsonNode? position in (JsonArray)request["points"]!)
            {
                using DBPoint point = new(PrimitiveAccess.Point(position));
                point.SetDatabaseDefaults(database);
                point.LayerId = PrimitiveAccess.Layer(database, transaction, request);
                handles.Add(PrimitiveAccess.Append(database, transaction, point).Handle.ToString());
            }

            return new { created = handles, pointType = "AutoCAD POINT" };
        }

        string[] targets = ((JsonArray)request["handles"]!).Select(node => node!.GetValue<string>()).ToArray();
        foreach (string handle in targets)
        {
            Entity entity = CivilObjectAccess.ByHandle(transaction, database, handle);
            DBPoint point = (DBPoint)transaction.GetObject(entity.ObjectId, OpenMode.ForWrite);
            if (request["position"] is not null)
            {
                point.Position = PrimitiveAccess.Point(request["position"]);
            }

            if (request["moveBy"] is not null)
            {
                point.Position += PrimitiveAccess.Point(request["moveBy"]) - Point3d.Origin;
            }

            if (request["layer"] is not null)
            {
                point.LayerId = PrimitiveAccess.Layer(database, transaction, request);
            }
        }

        return new { modified = targets };
    }
}
