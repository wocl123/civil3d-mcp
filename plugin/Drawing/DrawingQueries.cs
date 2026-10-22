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
    private const int MaxDetailVertices = 100;

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
        try
        {
            coordinateSystem = civil?.Settings.DrawingSettings.UnitZoneSettings.CoordinateSystemCode;
        }
        catch (System.Exception)
        {
            // 좌표계가 설정되지 않은 도면은 비워 둔다.
        }

        string version = Autodesk.AutoCAD.ApplicationServices.Application.GetSystemVariable("ACADVER")?.ToString()
            ?? string.Empty;

        return new DrawingStatus(
            document.Name,
            document.Database.Filename ?? string.Empty,
            version,
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
        ValidatePage(offset, limit);
        ValidateLayer(layer);

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        BlockTableRecord modelSpace = OpenModelSpace(document.Database, transaction);
        List<DrawingObject> items = new();
        int totalCount = 0;

        foreach (ObjectId id in modelSpace)
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity)
            {
                continue;
            }

            if (!OnLayer(entity, layer))
            {
                continue;
            }

            int index = totalCount++;
            if (index < offset || items.Count >= limit)
            {
                continue;
            }

            items.Add(new DrawingObject(
                entity.Handle.ToString(), entity.GetType().Name, entity.GetRXClass().DxfName, entity.Layer));
        }

        return new DrawingObjectPage(document.Name, offset, limit, totalCount, items);
    }

    // 2D 폴리선만, 요약과 함께.
    public static PolylinePage GetPolylines(Document document, int offset = 0, int limit = 20, string? layer = null)
    {
        ValidatePage(offset, limit);
        ValidateLayer(layer);

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<PolylineSummary> items = new();
        int totalCount = 0;

        foreach (ObjectId id in OpenModelSpace(document.Database, transaction))
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Polyline polyline)
            {
                continue;
            }

            if (!OnLayer(polyline, layer))
            {
                continue;
            }

            int index = totalCount++;
            if (index < offset || items.Count >= limit)
            {
                continue;
            }

            items.Add(Summarize(polyline));
        }

        return new PolylinePage(document.Name, offset, limit, totalCount, items);
    }

    // 폴리선 요약: 꼭짓점 수, 호 구간 수, 닫힘, 길이, 시작·끝 점.
    internal static PolylineSummary Summarize(Polyline polyline)
    {
        int last = polyline.NumberOfVertices - 1;
        int segments = polyline.Closed ? polyline.NumberOfVertices : last;
        int arcs = Enumerable.Range(0, Math.Max(segments, 0))
            .Count(segment => Math.Abs(polyline.GetBulgeAt(segment)) > 1e-9);

        Point2d start = polyline.GetPoint2dAt(0);
        Point2d end = polyline.GetPoint2dAt(last);

        return new PolylineSummary(
            polyline.Handle.ToString(), polyline.Layer, polyline.NumberOfVertices, arcs,
            polyline.Closed, Math.Round(polyline.Length, 3),
            [Math.Round(start.X, 3), Math.Round(start.Y, 3)],
            [Math.Round(end.X, 3), Math.Round(end.Y, 3)]);
    }

    // 레이어 목록(이름순): 켜짐·동결·잠금과 레이어별 객체 종류 수.
    // COGO 점은 모형 공간 목록에 없을 수 있어 따로 센다.
    public static DrawingLayerPage GetLayers(Document document, int offset = 0, int limit = 50)
    {
        ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();

        // 레이어 → (객체 종류 → 개수)
        var counts = new Dictionary<string, Dictionary<string, int>>(StringComparer.OrdinalIgnoreCase);
        void Count(string layer, string type)
        {
            if (!counts.TryGetValue(layer, out Dictionary<string, int>? types))
            {
                types = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                counts[layer] = types;
            }

            types[type] = types.GetValueOrDefault(type) + 1;
        }

        var seen = new HashSet<ObjectId>();
        foreach (ObjectId id in OpenModelSpace(document.Database, transaction))
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity)
            {
                continue;
            }

            seen.Add(id);
            Count(entity.Layer, entity.GetType().Name);
        }

        CivilDocument? civil = CivilApplication.ActiveDocument;
        if (civil is not null)
        {
            foreach (ObjectId id in civil.CogoPoints)
            {
                if (!seen.Add(id))
                {
                    continue;
                }

                if (transaction.GetObject(id, OpenMode.ForRead) is CogoPoint point)
                {
                    Count(point.Layer, nameof(CogoPoint));
                }
            }
        }

        // 객체가 없는 레이어도 목록에 넣는다.
        LayerTable table = (LayerTable)transaction.GetObject(document.Database.LayerTableId, OpenMode.ForRead);
        List<DrawingLayer> layers = new();

        foreach (ObjectId id in table)
        {
            LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(id, OpenMode.ForRead);
            counts.TryGetValue(layer.Name, out Dictionary<string, int>? types);

            layers.Add(new DrawingLayer(
                layer.Name, layer.IsOff, layer.IsFrozen, layer.IsLocked,
                types?.Values.Sum() ?? 0, types ?? new Dictionary<string, int>()));
        }

        layers.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.Name, b.Name));

        DrawingLayer[] page = layers.Skip(offset).Take(limit).ToArray();
        return new DrawingLayerPage(document.Name, offset, limit, layers.Count, page);
    }

    // 핸들 하나의 상세(모형 공간, 없으면 COGO 점에서 찾는다).
    public static DrawingObjectDetail GetObject(Document document, string handle)
    {
        if (string.IsNullOrWhiteSpace(handle) || handle.Length > 16)
        {
            throw new ArgumentException("A valid object handle is required.");
        }

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();

        foreach (ObjectId id in OpenModelSpace(document.Database, transaction))
        {
            if (transaction.GetObject(id, OpenMode.ForRead) is Entity entity && HasHandle(entity, handle))
            {
                return Describe(entity);
            }
        }

        CivilDocument? civil = CivilApplication.ActiveDocument;
        if (civil is not null)
        {
            foreach (ObjectId id in civil.CogoPoints)
            {
                if (transaction.GetObject(id, OpenMode.ForRead) is CogoPoint point && HasHandle(point, handle))
                {
                    return Describe(point);
                }
            }
        }

        throw new ArgumentException("Object handle was not found in the active drawing.");
    }

    // 종류별 형상 + 범위. 폴리선 꼭짓점은 100개까지.
    private static DrawingObjectDetail Describe(Entity entity)
    {
        object? geometry = entity switch
        {
            DBPoint point => new
            {
                position = Coordinates(point.Position)
            },
            CogoPoint point => new
            {
                position = Coordinates(point.Location),
                pointNumber = point.PointNumber,
                rawDescription = point.RawDescription
            },
            Line line => new
            {
                start = Coordinates(line.StartPoint),
                end = Coordinates(line.EndPoint)
            },
            Polyline polyline => new
            {
                elevation = polyline.Elevation,
                vertexCount = polyline.NumberOfVertices,
                closed = polyline.Closed,
                vertices = Vertices(polyline),
                verticesTruncated = polyline.NumberOfVertices > MaxDetailVertices
            },
            Polyline3d polyline => new
            {
                closed = polyline.Closed
            },
            Circle circle => new
            {
                center = Coordinates(circle.Center),
                radius = circle.Radius
            },
            DBText text => new
            {
                content = text.TextString,
                height = text.Height,
                rotationDegrees = Math.Round(text.Rotation * 180 / Math.PI, 2),
                position = Coordinates(text.Position)
            },
            MText text => new
            {
                content = text.Text,
                height = text.TextHeight,
                rotationDegrees = Math.Round(text.Rotation * 180 / Math.PI, 2),
                position = Coordinates(text.Location)
            },
            Dimension dimension => new
            {
                measurement = dimension.Measurement,
                textOverride = dimension.DimensionText,
                style = dimension.DimensionStyleName
            },
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
        catch (Autodesk.AutoCAD.Runtime.Exception)
        {
            // 범위가 없는 객체는 비워 둔다.
        }

        return new DrawingObjectDetail(
            entity.Handle.ToString(), entity.GetType().Name, entity.GetRXClass().DxfName, entity.Layer,
            geometry, min, max);
    }

    private static object[] Vertices(Polyline polyline)
    {
        int count = Math.Min(polyline.NumberOfVertices, MaxDetailVertices);

        return Enumerable.Range(0, count)
            .Select(index => (object)new
            {
                x = polyline.GetPoint2dAt(index).X,
                y = polyline.GetPoint2dAt(index).Y,
                bulge = polyline.GetBulgeAt(index)
            })
            .ToArray();
    }

    private static double[] Coordinates(Point3d point) => [point.X, point.Y, point.Z];

    private static bool HasHandle(Entity entity, string handle) =>
        string.Equals(entity.Handle.ToString(), handle, StringComparison.OrdinalIgnoreCase);

    // layer가 없으면 모두 통과.
    private static bool OnLayer(Entity entity, string? layer) =>
        layer is null || string.Equals(entity.Layer, layer, StringComparison.OrdinalIgnoreCase);

    internal static void ValidatePage(int offset, int limit)
    {
        if (offset < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(offset));
        }

        if (limit is < 1 or > 200)
        {
            throw new ArgumentOutOfRangeException(nameof(limit), "Limit must be between 1 and 200.");
        }
    }

    private static void ValidateLayer(string? layer)
    {
        if (layer is { Length: > 255 })
        {
            throw new ArgumentException("Layer name is too long.");
        }
    }

    private static BlockTableRecord OpenModelSpace(Database database, Transaction transaction)
    {
        BlockTable blockTable = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
        return (BlockTableRecord)transaction.GetObject(blockTable[BlockTableRecord.ModelSpace], OpenMode.ForRead);
    }
}
