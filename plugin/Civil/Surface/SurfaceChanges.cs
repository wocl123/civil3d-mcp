using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;
using Surface = Autodesk.Civil.DatabaseServices.Surface;

namespace MyCivil3DMcp.Plugin;

internal static class SurfaceChanges
{
    public static object List(Document document, int offset, int limit)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Surface[] surfaces = CivilObjectAccess.All<Surface>(transaction, document.Database).ToArray();
        return new { total = surfaces.Length, offset, items = surfaces.Skip(Math.Max(0, offset))
            .Take(Math.Clamp(limit, 1, 50)).Select(Info).ToArray() };
    }

    public static object Get(Document document, string key)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Surface surface = CivilObjectAccess.Find<Surface>(transaction, document.Database, key);
        return new { surface = Info(surface), references = SurfaceReferences.Read(document.Database, transaction, surface),
            editable = surface is TinSurface && !surface.IsReferenceObject && !surface.IsReferenceSubObject };
    }

    private static object Info(Surface surface) => new
    {
        surface.Name, handle = surface.Handle.ToString(), type = surface.GetType().Name,
        surface.Description, surface.Layer, style = surface.StyleName, surface.IsReferenceObject,
        vertices = surface is TinSurface tin ? (int?)tin.Vertices.Count : null
    };

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "surface.create")
        {
            string name = CivilObjectAccess.Text(request, "name");
            CivilObjectAccess.FreeName<Surface>(transaction, database, name);
            ValidateProperties(database, transaction, request, null, details);
            ValidateGeometry(request, null, details);
            return $"TIN 지표면 {name} 생성";
        }

        Surface surface = CivilObjectAccess.Find<Surface>(transaction, database,
            CivilObjectAccess.Text(request, "surface"));
        CivilObjectAccess.Editable(surface);
        request["surface"] = surface.Handle.ToString();
        details.Add($"대상: {surface.Name} [{surface.Handle}], {surface.GetType().Name}");
        string[] references = SurfaceReferences.Read(database, transaction, surface);
        details.AddRange(references.Select(item => "연결 객체: " + item));
        if (operation == "surface.delete")
        {
            if (references.Length > 0)
            {
                throw new ArgumentException("연결된 객체가 있어 지표면을 삭제하지 않습니다: " + string.Join(", ", references));
            }

            return $"지표면 {surface.Name} 삭제";
        }

        TinSurface tin = surface as TinSurface ?? throw new ArgumentException("형상 편집은 TIN 지표면만 지원합니다.");
        ValidateProperties(database, transaction, request, surface, details);
        ValidateGeometry(request, tin, details);
        details.Add("연결된 종단·코리더·토공 계산 결과가 갱신될 수 있습니다.");
        return $"지표면 {surface.Name} 수정";
    }

    private static void ValidateProperties(Database database, Transaction transaction, JsonObject request,
        Surface? surface, List<string> details)
    {
        if (request["newName"] is not null)
        {
            string name = CivilObjectAccess.Text(request, "newName");
            CivilObjectAccess.FreeName<Surface>(transaction, database, name, surface?.ObjectId ?? ObjectId.Null);
            details.Add($"이름: {surface?.Name} → {name}");
        }

        CivilPropertyChanges.Validate(database, transaction, request, surface, "surface", details);
    }

    private static void ValidateGeometry(JsonObject request, TinSurface? surface, List<string> details)
    {
        if (request["points"] is not null)
        {
            Point3dCollection points = Points(request["points"], 1, 10000);
            EnsureUnique(points);
            details.Add($"XYZ 점 {points.Count}개 추가");
        }

        if (request["breaklines"] is JsonArray breaklines)
        {
            if (breaklines.Count is < 1 or > 100)
            {
                throw new ArgumentException("브레이크라인은 1~100개여야 합니다.");
            }

            foreach (JsonNode? line in breaklines)
            {
                EnsureUnique(Points(line, 2, 1000));
            }

            details.Add($"표준 브레이크라인 {breaklines.Count}개 추가");
        }

        if (request["boundary"] is not null)
        {
            Points(request["boundary"], 3, 1000);
            details.Add("외곽 경계 추가 (기존 경계 정의는 유지)");
        }

        ValidateVertices(request, surface, details);
        if (request["elevationDelta"] is not null)
        {
            details.Add($"전체 지표면 표고 증감: {CivilObjectAccess.Number(request["elevationDelta"])}");
        }

        if (request["rebuild"]?.GetValue<bool>() == true)
        {
            details.Add("지표면 재작성");
        }
    }

    private static void ValidateVertices(JsonObject request, TinSurface? surface, List<string> details)
    {
        if (request["deleteVertices"] is not JsonArray vertices)
        {
            return;
        }

        if (surface is null || vertices.Count is < 1 or > 1000)
        {
            throw new ArgumentException("기존 지표면의 정점 1~1000개만 삭제할 수 있습니다.");
        }

        HashSet<(double, double)> seen = new();
        foreach (JsonNode? vertex in vertices)
        {
            double x = CivilObjectAccess.Number(vertex?["x"]);
            double y = CivilObjectAccess.Number(vertex?["y"]);
            if (!seen.Add((x, y)))
            {
                throw new ArgumentException("삭제할 정점 좌표가 중복됩니다.");
            }

            surface.FindVertexAtXY(x, y);
        }

        details.Add($"기존 TIN 정점 {vertices.Count}개 삭제");
    }

    internal static Point3dCollection Points(JsonNode? node, int minimum, int maximum)
    {
        JsonArray array = node as JsonArray ?? throw new ArgumentException("XYZ 점 목록이 필요합니다.");
        if (array.Count < minimum || array.Count > maximum)
        {
            throw new ArgumentException($"점은 {minimum}~{maximum}개여야 합니다.");
        }

        Point3dCollection result = new();
        foreach (JsonNode? point in array)
        {
            result.Add(new Point3d(CivilObjectAccess.Number(point?["x"]),
                CivilObjectAccess.Number(point?["y"]), CivilObjectAccess.Number(point?["z"])));
        }

        return result;
    }

    private static void EnsureUnique(Point3dCollection points)
    {
        int unique = points.Cast<Point3d>().Select(point => (point.X, point.Y)).Distinct().Count();
        if (unique != points.Count)
        {
            throw new ArgumentException("같은 XY 좌표의 점이 중복됩니다.");
        }
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        Surface surface;
        if (operation == "surface.create")
        {
            ObjectId style = CivilObjectAccess.Style(transaction, database, "surface", request["style"]?.ToString());
            ObjectId id = TinSurface.Create(CivilObjectAccess.Text(request, "name"), style);
            surface = (Surface)transaction.GetObject(id, OpenMode.ForWrite);
        }
        else
        {
            surface = CivilObjectAccess.Find<Surface>(transaction, database,
                CivilObjectAccess.Text(request, "surface"));
            surface = (Surface)transaction.GetObject(surface.ObjectId, OpenMode.ForWrite);
        }

        string handle = surface.Handle.ToString();
        if (operation == "surface.delete")
        {
            Delete(database, surface);
            return new { deleted = handle };
        }

        CivilPropertyChanges.Apply(database, transaction, request, surface, "surface");
        ApplyGeometry((TinSurface)surface, request);
        return new { surface.Name, handle, vertices = ((TinSurface)surface).Vertices.Count };
    }

    private static void Delete(Database database, Surface surface)
    {
        using DrawingRevisions.Recorder journal = DrawingRevisions.Record(database);
        surface.Erase();
        bool unexpected = journal.Overflowed || journal.Changes.Any(change =>
            change.Event == "삭제" && change.Counted && change.Handle != surface.Handle.ToString());
        if (unexpected)
        {
            throw new InvalidOperationException("계획하지 않은 객체의 종속 삭제를 감지해 전체 삭제를 취소했습니다.");
        }
    }

    private static void ApplyGeometry(TinSurface surface, JsonObject request)
    {
        if (request["deleteVertices"] is JsonArray vertices)
        {
            TinSurfaceVertex[] targets = vertices.Select(vertex => surface.FindVertexAtXY(
                CivilObjectAccess.Number(vertex?["x"]), CivilObjectAccess.Number(vertex?["y"]))).ToArray();
            surface.DeleteVertices(targets);
        }

        if (request["points"] is not null)
        {
            surface.AddVertices(Points(request["points"], 1, 10000));
        }

        if (request["breaklines"] is JsonArray breaklines)
        {
            foreach (JsonNode? line in breaklines)
            {
                surface.BreaklinesDefinition.AddStandardBreaklines(Points(line, 2, 1000), 0.1, 0, 0, 0);
            }
        }

        if (request["boundary"] is not null)
        {
            surface.BoundariesDefinition.AddBoundaries(Points(request["boundary"], 3, 1000), 0.1,
                SurfaceBoundaryType.Outer, true);
        }

        if (request["elevationDelta"] is not null)
        {
            surface.RaiseSurface(CivilObjectAccess.Number(request["elevationDelta"]));
        }

        surface.Rebuild();
    }
}
