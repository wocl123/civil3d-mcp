using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using CogoPoint = Autodesk.Civil.DatabaseServices.CogoPoint;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 도면 조회(읽기만). 브리지나 명령이 올바른 Civil 3D 명령 컨텍스트에서 부른다.
/// 목록은 offset/limit로 나눠 준다(limit 1~200).
/// </summary>
public static class DrawingQueries
{
    // 도면 이름·경로·버전, 모형 공간 객체 수, 단위·좌표계, 리비전.
    public static DrawingStatus GetStatus(Document document)
    {
        ArgumentNullException.ThrowIfNull(document);

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        BlockTableRecord modelSpace = OpenModelSpace(document.Database, transaction);
        int count = 0;
        foreach (ObjectId _ in modelSpace)
        {
            count++;
        }

        CivilDocument? civil = CivilApplication.ActiveDocument;
        string? coordinateSystem = null;
        try { coordinateSystem = civil?.Settings.DrawingSettings.UnitZoneSettings.CoordinateSystemCode; }
        catch (System.Exception) { }
        return new DrawingStatus(
            document.Name,
            document.Database.Filename ?? string.Empty,
            Autodesk.AutoCAD.ApplicationServices.Application.GetSystemVariable("ACADVER")?.ToString() ?? string.Empty,
            CivilApplication.ActiveDocument is not null,
            count)
        {
            DrawingUnits = document.Database.Insunits.ToString(),
            CoordinateSystem = coordinateSystem,
            DrawingId = DrawingRevisions.Id(document.Database),
            Revision = DrawingRevisions.Of(document.Database)
        };
    }

    // 모형 공간 객체 목록(레이어로 거를 수 있음).
    public static DrawingObjectPage GetObjects(Document document, int offset = 0, int limit = 20,
        string? layer = null)
    {
        ArgumentNullException.ThrowIfNull(document);
        if (offset < 0) throw new ArgumentOutOfRangeException(nameof(offset));
        if (limit is < 1 or > 200) throw new ArgumentOutOfRangeException(nameof(limit), "Limit must be between 1 and 200.");
        if (layer is { Length: > 255 }) throw new ArgumentException("Layer name is too long.");

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        BlockTableRecord modelSpace = OpenModelSpace(document.Database, transaction);
        List<DrawingObject> items = new();
        int totalCount = 0;

        foreach (ObjectId id in modelSpace)
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;
            if (layer is not null && !string.Equals(entity.Layer, layer, StringComparison.OrdinalIgnoreCase)) continue;
            int index = totalCount++;
            if (index < offset || items.Count >= limit) continue;

            items.Add(new DrawingObject(
                entity.Handle.ToString(),
                entity.GetType().Name,
                entity.GetRXClass().DxfName,
                entity.Layer));
        }

        return new DrawingObjectPage(document.Name, offset, limit, totalCount, items);
    }

    // 2D 폴리선만, 요약과 함께.
    public static PolylinePage GetPolylines(Document document, int offset = 0, int limit = 20, string? layer = null)
    {
        ValidatePage(offset, limit);
        if (layer is { Length: > 255 }) throw new ArgumentException("Layer name is too long.");
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<PolylineSummary> items = new();
        int totalCount = 0;
        foreach (ObjectId id in OpenModelSpace(document.Database, transaction))
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Polyline polyline) continue;
            if (layer is not null && !string.Equals(polyline.Layer, layer, StringComparison.OrdinalIgnoreCase)) continue;
            int index = totalCount++;
            if (index < offset || items.Count >= limit) continue;
            items.Add(Summarize(polyline));
        }
        return new PolylinePage(document.Name, offset, limit, totalCount, items);
    }

    // 폴리선 요약: 꼭짓점 수, 호 구간 수, 닫힘, 길이, 시작·끝 점.
    internal static PolylineSummary Summarize(Polyline polyline)
    {
        int last = polyline.NumberOfVertices - 1;
        int segments = polyline.Closed ? polyline.NumberOfVertices : last;
        int arcs = Enumerable.Range(0, Math.Max(segments, 0)).Count(segment => Math.Abs(polyline.GetBulgeAt(segment)) > 1e-9);
        Point2d start = polyline.GetPoint2dAt(0);
        Point2d end = polyline.GetPoint2dAt(last);
        return new PolylineSummary(polyline.Handle.ToString(), polyline.Layer, polyline.NumberOfVertices, arcs,
            polyline.Closed, Math.Round(polyline.Length, 3), [Math.Round(start.X, 3), Math.Round(start.Y, 3)],
            [Math.Round(end.X, 3), Math.Round(end.Y, 3)]);
    }

    // 레이어 목록(이름순): 켜짐·동결·잠금과 레이어별 객체 종류 수.
    // COGO 점은 모형 공간 목록에 없을 수 있어 따로 센다.
    public static DrawingLayerPage GetLayers(Document document, int offset = 0, int limit = 50)
    {
        ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        var counts = new Dictionary<string, Dictionary<string, int>>(StringComparer.OrdinalIgnoreCase);
        var seen = new HashSet<ObjectId>();
        foreach (ObjectId id in OpenModelSpace(document.Database, transaction))
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;
            seen.Add(id);
            if (!counts.TryGetValue(entity.Layer, out Dictionary<string, int>? types))
                counts[entity.Layer] = types = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            string type = entity.GetType().Name;
            types[type] = types.GetValueOrDefault(type) + 1;
        }
        CivilDocument? civil = CivilApplication.ActiveDocument;
        if (civil is not null)
            foreach (ObjectId id in civil.CogoPoints)
            {
                if (!seen.Add(id) || transaction.GetObject(id, OpenMode.ForRead) is not CogoPoint point) continue;
                if (!counts.TryGetValue(point.Layer, out Dictionary<string, int>? types))
                    counts[point.Layer] = types = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                types[nameof(CogoPoint)] = types.GetValueOrDefault(nameof(CogoPoint)) + 1;
            }

        // 객체가 없는 레이어도 목록에 넣는다.
        LayerTable table = (LayerTable)transaction.GetObject(document.Database.LayerTableId, OpenMode.ForRead);
        List<DrawingLayer> layers = new();
        foreach (ObjectId id in table)
        {
            LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(id, OpenMode.ForRead);
            counts.TryGetValue(layer.Name, out Dictionary<string, int>? types);
            layers.Add(new DrawingLayer(layer.Name, layer.IsOff, layer.IsFrozen, layer.IsLocked,
                types?.Values.Sum() ?? 0, types ?? new Dictionary<string, int>()));
        }
        layers.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));
        return new DrawingLayerPage(document.Name, offset, limit, layers.Count,
            layers.Skip(offset).Take(limit).ToArray());
    }

    // 핸들 하나의 상세(모형 공간, 없으면 COGO 점에서 찾는다).
    public static DrawingObjectDetail GetObject(Document document, string handle)
    {
        if (string.IsNullOrWhiteSpace(handle) || handle.Length > 16)
            throw new ArgumentException("A valid object handle is required.");
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        foreach (ObjectId id in OpenModelSpace(document.Database, transaction))
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is Entity entity &&
                string.Equals(entity.Handle.ToString(), handle, StringComparison.OrdinalIgnoreCase))
                return Describe(entity);
        }
        CivilDocument? civil = CivilApplication.ActiveDocument;
        if (civil is not null)
            foreach (ObjectId id in civil.CogoPoints)
                if (transaction.GetObject(id, OpenMode.ForRead) is CogoPoint point &&
                    string.Equals(point.Handle.ToString(), handle, StringComparison.OrdinalIgnoreCase))
                    return Describe(point);
        throw new ArgumentException("Object handle was not found in the active drawing.");
    }

    // 종류별 형상 + 범위. 폴리선 꼭짓점은 100개까지.
    private static DrawingObjectDetail Describe(Entity entity)
    {
        object? geometry = entity switch
        {
            DBPoint point => new { position = Coordinates(point.Position) },
            CogoPoint point => new { position = Coordinates(point.Location), pointNumber = point.PointNumber,
                rawDescription = point.RawDescription },
            Line line => new { start = Coordinates(line.StartPoint), end = Coordinates(line.EndPoint) },
            Polyline polyline => new
            {
                elevation = polyline.Elevation,
                vertexCount = polyline.NumberOfVertices,
                closed = polyline.Closed,
                vertices = Enumerable.Range(0, Math.Min(polyline.NumberOfVertices, 100)).Select(index => new
                {
                    x = polyline.GetPoint2dAt(index).X,
                    y = polyline.GetPoint2dAt(index).Y,
                    bulge = polyline.GetBulgeAt(index)
                }).ToArray(),
                verticesTruncated = polyline.NumberOfVertices > 100
            },
            Polyline3d polyline => new { closed = polyline.Closed },
            Circle circle => new { center = Coordinates(circle.Center), radius = circle.Radius },
            _ => null
        };
        double[]? min = null;
        double[]? max = null;
        try
        {
            Extents3d bounds = entity.GeometricExtents;
            min = Coordinates(bounds.MinPoint);
            max = Coordinates(bounds.MaxPoint);
        }
        catch (Autodesk.AutoCAD.Runtime.Exception) { }
        return new DrawingObjectDetail(entity.Handle.ToString(), entity.GetType().Name,
            entity.GetRXClass().DxfName, entity.Layer, geometry, min, max);
    }

    private static double[] Coordinates(Point3d point) => [point.X, point.Y, point.Z];

    internal static void ValidatePage(int offset, int limit)
    {
        if (offset < 0) throw new ArgumentOutOfRangeException(nameof(offset));
        if (limit is < 1 or > 200) throw new ArgumentOutOfRangeException(nameof(limit),
            "Limit must be between 1 and 200.");
    }

    private static BlockTableRecord OpenModelSpace(Database database, Transaction transaction)
    {
        BlockTable blockTable = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
        return (BlockTableRecord)transaction.GetObject(blockTable[BlockTableRecord.ModelSpace], OpenMode.ForRead);
    }
}
