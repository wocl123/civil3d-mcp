using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;

namespace CivilCrud.Native;

public partial class Commands
{
    private static JsonObject ReadResult(string type, string method, params object?[] args) =>
        JsonSerializer.SerializeToNode(Invoke(type, method, args), Json)!.AsObject();

    private static void TestPrimitives(Document document)
    {
        TestDimensions(document);
        TestPoints(document);
        TestCleanup(document);
        TestSurfaceBatch(document);
        TestViewerDispatch(document);
        TestPrimitiveUndo(document);
        TestDrawingTools(document);
    }

    private static void TestDimensions(Document document)
    {
        List<string> dimensions = new();
        foreach (string kind in new[] { "aligned", "rotated", "radial", "diametric", "angular", "ordinate" })
        {
            JsonObject request = new()
            {
                ["operation"] = "dimension.create", ["kind"] = kind,
                ["start"] = new JsonObject { ["x"] = 20, ["y"] = 0, ["z"] = 0 },
                ["end"] = new JsonObject { ["x"] = 0, ["y"] = 20, ["z"] = 0 },
                ["center"] = new JsonObject { ["x"] = 0, ["y"] = 0, ["z"] = 0 },
                ["location"] = new JsonObject { ["x"] = 30, ["y"] = 30, ["z"] = 0 },
                ["rotationDegrees"] = 0
            };
            dimensions.Add(Apply(document, request.ToJsonString())["created"]![0]!.GetValue<string>());
        }

        Check(ReadResult("DimensionChanges", "List", document, 0, 200)["totalCount"]!.GetValue<int>() == 6,
            "six native dimension types created and listed");
        Apply(document, new JsonObject { ["operation"] = "dimension.edit", ["handles"] = new JsonArray(dimensions[0]),
            ["text"] = "검토 <>" }.ToJsonString());
        EntityCheck<Dimension>(document, dimensions[0], dimension => dimension.DimensionText == "검토 <>",
            "dimension text edit uses writable object");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "dimension.edit",
            ["handles"] = new JsonArray(dimensions[0]), ["rotationDegrees"] = 30 }.ToJsonString()),
            "non-rotated dimension rotation rejected");

        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(document.Database.CurrentSpaceId, OpenMode.ForWrite);
            for (int index = 6; index < 98; index++)
            {
                using AlignedDimension dimension = new(new Point3d(index, 0, 0), new Point3d(index, 5, 0),
                    new Point3d(index + 1, 2, 0), "", document.Database.Dimstyle);
                space.AppendEntity(dimension);
                transaction.AddNewlyCreatedDBObject(dimension, true);
            }

            transaction.Commit();
        }

        JsonObject plan = Preview(document, """{"operation":"dimension.delete","all":true}""");
        Check(plan["request"]!["handles"]!.AsArray().Count == 98, "all 98 dimensions enumerated in deletion plan");
        Apply(document, """{"operation":"dimension.delete","all":true}""");
        Check(ReadResult("DimensionChanges", "List", document, 0, 200)["totalCount"]!.GetValue<int>() == 0,
            "all ordinary dimensions deleted");
    }

    private static void EntityCheck<T>(Document document, string handle, Func<T, bool> test, string name) where T : Entity
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        ObjectId id = document.Database.GetObjectId(false, new Handle(Convert.ToInt64(handle, 16)), 0);
        Check(transaction.GetObject(id, OpenMode.ForRead) is T entity && test(entity), name);
    }

    private static void TestPoints(Document document)
    {
        string source;
        Point3d expected;
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(document.Database.CurrentSpaceId, OpenMode.ForWrite);
            using Polyline polyline = new() { Closed = true, Normal = Vector3d.YAxis, Elevation = 7 };
            foreach (Point2d point in new[] { new Point2d(0, 0), new Point2d(5, 0), new Point2d(5, 5), new Point2d(0, 5) })
            {
                polyline.AddVertexAt(polyline.NumberOfVertices, point, 0, 0, 0);
            }

            source = space.AppendEntity(polyline).Handle.ToString();
            transaction.AddNewlyCreatedDBObject(polyline, true);
            expected = polyline.GetPoint3dAt(0);
            transaction.Commit();
        }

        JsonObject created = Apply(document, new JsonObject { ["operation"] = "point.create",
            ["verticesOf"] = new JsonArray(source, source) }.ToJsonString());
        Check(created["created"]!.AsArray().Count == 4, "closed tilted polyline yields four unique WCS corner points");
        string handle = created["created"]![0]!.GetValue<string>();
        EntityCheck<DBPoint>(document, handle, point => point.Position.DistanceTo(expected) < 1e-9,
            "point vertices preserve source WCS elevation and normal");
        Apply(document, new JsonObject { ["operation"] = "point.edit", ["handles"] = new JsonArray(handle),
            ["moveBy"] = new JsonObject { ["x"] = 1, ["y"] = 2, ["z"] = 3 } }.ToJsonString());
        EntityCheck<DBPoint>(document, handle, point => point.Position.DistanceTo(expected + new Vector3d(1, 2, 3)) < 1e-9,
            "point relative XYZ edit");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "point.delete",
            ["handles"] = new JsonArray(source) }.ToJsonString()), "point deletion refuses source polyline");
        Apply(document, """{"operation":"point.delete","all":true}""");
        Check(ReadResult("PointChanges", "List", document, 0, 200)["totalCount"]!.GetValue<int>() == 0,
            "ordinary point deletion");
        EntityCheck<Polyline>(document, source, line => !line.IsErased, "source polyline retained after point deletion");
    }

    private static void TestCleanup(Document document)
    {
        string duplicate, kept, different, zero, empty, point;
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(document.Database.CurrentSpaceId, OpenMode.ForWrite);
            string Append(Entity entity)
            {
                ObjectId id = space.AppendEntity(entity);
                transaction.AddNewlyCreatedDBObject(entity, true);
                return id.Handle.ToString();
            }

            Point3d from = new(500, 500, 0);
            Point3d to = new(510, 500, 0);
            kept = Append(new Line(from, to));
            duplicate = Append(new Line(to, from));
            different = Append(new Line(from, to) { ColorIndex = 3 });
            zero = Append(new Line(from, from));
            empty = Append(new DBText { Position = from, TextString = "", Height = 1 });
            point = Append(new DBPoint(from));
            transaction.Commit();
        }

        JsonArray candidates = ReadResult("DrawingCleanup", "Inspect", document, 0, 200)["items"]!.AsArray();
        HashSet<string> handles = candidates.Select(item => item!["handle"]!.GetValue<string>()).ToHashSet();
        Check(handles.Contains(duplicate) && handles.Contains(zero) && handles.Contains(empty),
            "cleanup reports extra duplicate, exact zero length and empty text");
        Check(!handles.Contains(kept) && !handles.Contains(different) && !handles.Contains(point),
            "cleanup retains keeper, differently styled line and point");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "cleanup.delete",
            ["handles"] = new JsonArray(kept) }.ToJsonString()), "cleanup refuses non-candidate deletion");
        Apply(document, new JsonObject { ["operation"] = "cleanup.delete",
            ["handles"] = new JsonArray(duplicate, zero, empty) }.ToJsonString());
        EntityCheck<Line>(document, kept, line => !line.IsErased, "cleanup leaves original geometry intact");
    }

    private static void TestSurfaceBatch(Document document)
    {
        foreach (string name in new[] { "BATCH-Rock-A", "BATCH-Rock-B" })
        {
            Apply(document, new JsonObject { ["operation"] = "surface.create", ["name"] = name,
                ["style"] = "CRUD-Test" }.ToJsonString());
        }

        Reject(() => Preview(document, """{"operation":"surface.deleteMany","surfaces":["BATCH-Rock-A","CRUD-Raised"]}"""),
            "surface batch refuses dependent target before deleting any surface");
        Check(ReadResult("SurfaceChanges", "Get", document, "BATCH-Rock-A")["surface"] is not null,
            "surface batch dependency refusal preserves independent target");
        JsonObject result = Apply(document, """{"operation":"surface.deleteMany","nameContains":"BATCH-Rock"}""");
        Check(result["deleted"]!.AsArray().Count == 2, "surface matching-name batch deletion");
    }

    private static void TestViewerDispatch(Document document)
    {
        ObjectId id;
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(document.Database.CurrentSpaceId, OpenMode.ForWrite);
            using Line line = new(Point3d.Origin, new Point3d(1, 1, 1));
            id = space.AppendEntity(line);
            transaction.AddNewlyCreatedDBObject(line, true);
            transaction.Commit();
        }

        string token = (string)Invoke("DrawingViewer", "Prepare", document, new[] { id });
        ObjectId[] ids = (ObjectId[])Invoke("DrawingViewer", "Take", document, token);
        document.Editor.SetImpliedSelection(ids);
        Check(document.Editor.SelectImplied().Value.GetObjectIds().SequenceEqual(new[] { id }),
            "viewer queued command can restore exact selection after bridge return");
        Reject(() => Invoke("DrawingViewer", "Take", document, token), "viewer request token cannot be replayed");
        var method = _plugin!.GetType("MyCivil3DMcp.Plugin.PluginEntry")!.GetMethod("OpenObjectViewer")!;
        CommandMethodAttribute attribute = method.GetCustomAttributes(typeof(CommandMethodAttribute), false)
            .Cast<CommandMethodAttribute>().Single();
        Check(attribute.GlobalName == "MYC3DOBJECTVIEWER" && attribute.Flags.HasFlag(CommandFlags.UsePickSet),
            "viewer queued command is registered with PickFirst preservation");
    }

    private static void TestPrimitiveUndo(Document document)
    {
        foreach (string input in new[]
        {
            """{"operation":"dimension.create","kind":"aligned","start":{"x":0,"y":0,"z":0},"end":{"x":10,"y":0,"z":0},"location":{"x":5,"y":2,"z":0}}""",
            """{"operation":"point.create","points":[{"x":900,"y":900,"z":9}]}"""
        })
        {
            TestPrimitiveUndo(document, input, delete: false);
            TestPrimitiveUndo(document, input, delete: true);
        }
    }

    private static void TestPrimitiveUndo(Document document, string input, bool delete)
    {
        JsonObject request = JsonNode.Parse(input)!.AsObject();
        if (delete)
        {
            JsonObject created = Apply(document, input);
            request = new JsonObject
            {
                ["operation"] = request["operation"]!.GetValue<string>().Replace("create", "delete"),
                ["handles"] = created["created"]!.DeepClone()
            };
        }

        JsonObject plan = Preview(document, request.ToJsonString());
        string id = Guid.NewGuid().ToString();
        JsonObject parameters = new() { ["operationId"] = id, ["plan"] = plan };
        JsonObject context = new()
        {
            ["drawingId"] = (string)Invoke("DrawingRevisions", "Id", document.Database),
            ["revision"] = (string)Invoke("DrawingRevisions", "Of", document.Database)
        };
        string type = plan["request"]!["operation"]!.GetValue<string>().StartsWith("dimension")
            ? "DimensionChanges" : "PointChanges";
        int before = ReadResult(type, "List", document, 0, 200)["totalCount"]!.GetValue<int>();
        Func<object> action = () => Invoke("CivilPlans", "Apply", document, parameters);
        Invoke("DrawingOperations", "Apply", document, parameters, context, action);
        Check(ReadResult(type, "List", document, 0, 200)["totalCount"]!.GetValue<int>() == before + (delete ? -1 : 1),
            type + (delete ? " guarded deletion removes exactly one entity" : " guarded creation adds exactly one entity"));
        JsonObject undone = ReadResult("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = id });
        Check(undone["state"]?.ToString() == "undone"
            && ReadResult(type, "List", document, 0, 200)["totalCount"]!.GetValue<int>() == before,
            type + (delete ? " native delete Undo restores entity count" : " native create Undo restores entity count"));
    }
}
