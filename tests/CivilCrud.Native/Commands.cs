using System.Reflection;
using System.IO;
using System.IO.Compression;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.Runtime;
using Autodesk.Civil;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;
using Assembly = System.Reflection.Assembly;

[assembly: CommandClass(typeof(CivilCrud.Native.Commands))]

namespace CivilCrud.Native;

// 전용 임시 도면에서만 실행한다. 결과는 환경 변수로 지정한 작업 폴더에 기록한다.
public partial class Commands
{
    private static Assembly? _plugin;
    private static readonly JsonSerializerOptions Json = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly List<string> Passed = new();

    [CommandMethod("MYC3DCRUDPREPARE")]
    public void PrepareSavedDrawing()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        Document document = App.DocumentManager.MdiActiveDocument;
        _plugin = Assembly.LoadFrom(Path.Combine(folder, "MyCivil3DMcp.Plugin.dll"));
        Prepare(document);
        foreach (string name in new[] { "Persist-Delete", "Persist-Edit" })
        {
            Apply(document, "{\"operation\":\"surface.create\",\"name\":\"" + name + "\","
                + "\"style\":\"CRUD-Test\",\"points\":[{\"x\":0,\"y\":0,\"z\":10},"
                + "{\"x\":100,\"y\":0,\"z\":12},{\"x\":0,\"y\":100,\"z\":15}]}");
        }

        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            CivilDocument civil = CivilDocument.GetCivilDocument(document.Database);
            ObjectId[] surfaces = civil.GetSurfaceIds().Cast<ObjectId>().ToArray();
            ObjectId pastedId = TinSurface.Create("Persist-Pasted", civil.Styles.SurfaceStyles["CRUD-Test"]);
            TinSurface pasted = (TinSurface)transaction.GetObject(pastedId, OpenMode.ForWrite);
            pasted.PasteSurface(surfaces[1]);
            pasted.Rebuild();
            TinVolumeSurface.Create("Persist-Volume", surfaces[0], surfaces[1]);
            transaction.Commit();
        }

        foreach (string name in new[] { "Persist-FG-Edit", "Persist-FG-Delete" })
        {
            Apply(document, "{\"operation\":\"profile.create\",\"name\":\"" + name + "\","
                + "\"alignment\":\"CRUD-Alignment\",\"type\":\"layout\",\"style\":\"CRUD-Test\","
                + "\"labelSet\":\"CRUD-Test\",\"pvis\":[{\"station\":0,\"elevation\":10},"
                + "{\"station\":100,\"elevation\":12}]}");
        }

        Apply(document, """
            {"operation":"profile.create","name":"Persist-EG","alignment":"CRUD-Alignment","type":"surface",
            "surface":"Persist-Edit","style":"CRUD-Test","labelSet":"CRUD-Test","endStation":99}
            """);

        Invoke("DrawingLayers", "Apply", document, JsonNode.Parse("""
            {"action":"create","create":[{"name":"Persist-Layer","color":3,"locked":false,"frozen":false,"off":false}]}
            """));
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(document.Database.CurrentSpaceId, OpenMode.ForWrite);
            using Line line = new(new Point3d(200, 0, 0), new Point3d(210, 0, 0)) { Layer = "Persist-Layer" };
            space.AppendEntity(line);
            transaction.AddNewlyCreatedDBObject(line, true);
            transaction.Commit();
        }

        TestEngineeringObjects(document);
        document.Database.SaveAs(Path.Combine(folder, "fixture.dwg"), DwgVersion.Current);
        File.WriteAllText(Path.Combine(folder, "prepared.json"), "{\"prepared\":true}");
    }

    [CommandMethod("MYC3DCRUDPERSISTTEST")]
    public void TestSavedDrawing()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        _plugin = Assembly.LoadFrom(Path.Combine(folder, "MyCivil3DMcp.Plugin.dll"));
        Document document = App.DocumentManager.MdiActiveDocument;
        List<string> failures = new();
        void Test(string name, Action action)
        {
            try { action(); Passed.Add(name); }
            catch (System.Exception error) { failures.Add(name + ": " + error); }
        }

        Test("saved surface dependency protection", () => Reject(() => Apply(document,
            """{"operation":"surface.delete","surface":"Persist-Delete"}"""), "volume source guarded"));
        Test("saved pasted surface delete", () => Apply(document,
            """{"operation":"surface.delete","surface":"Persist-Pasted"}"""));
        Test("saved volume surface delete", () => Apply(document,
            """{"operation":"surface.delete","surface":"Persist-Volume"}"""));
        Test("saved populated surface delete", () => Apply(document,
            """{"operation":"surface.delete","surface":"Persist-Delete"}"""));
        Test("saved populated surface edit", () => Apply(document,
            """{"operation":"surface.edit","surface":"Persist-Edit","elevationDelta":2,"description":"edited"}"""));
        Test("saved profile edit", () => Apply(document, """
            {"operation":"profile.edit","profile":"Persist-FG-Edit","newName":"Persist-FG-Renamed",
            "replacePvis":[{"station":0,"elevation":11},{"station":100,"elevation":14}]}
            """));
        Test("saved alignment edit", () =>
        {
            using Transaction transaction = document.Database.TransactionManager.StartTransaction();
            CivilDocument civil = CivilDocument.GetCivilDocument(document.Database);
            Alignment alignment = civil.GetAlignmentIds().Cast<ObjectId>()
                .Select(id => (Alignment)transaction.GetObject(id, OpenMode.ForRead))
                .Single(item => item.Name == "CRUD-Alignment");
            JsonArray input = new(new JsonObject { ["handle"] = alignment.Handle.ToString(),
                ["name"] = alignment.Name, ["description"] = "saved alignment edited" });
            transaction.Commit();
            object edits = Invoke("AlignmentEditing", "ReadEdits", input);
            Invoke("AlignmentEditing", "Apply", document, edits);
        });
        Test("saved layer edit", () => EditLayer(document,
            """{"action":"edit","names":["Persist-Layer"],"locked":true,"frozen":true}"""));
        Test("saved profile delete", () =>
        {
            JsonObject preview = JsonSerializer.SerializeToNode(Invoke("DrawingDeletion", "Preview", document,
                JsonNode.Parse("""{"profiles":[{"profile":"Persist-FG-Delete"}]}""")), Json)!.AsObject();
            object targets = Invoke("DrawingDeletion", "ReadTargets", preview["items"]);
            Invoke("DrawingDeletion", "Delete", document, targets);
        });
        Test("saved layer and objects delete", () =>
        {
            EditLayer(document, """{"action":"edit","names":["Persist-Layer"],"locked":false,"frozen":false}""");
            JsonObject preview = LayerPreview(document,
                """{"action":"delete","names":["Persist-Layer"],"deleteObjects":true}""");
            Invoke("DrawingLayers", "Apply", document, new JsonObject { ["action"] = "delete",
                ["deleteObjects"] = true, ["targets"] = preview["items"]!.DeepClone() });
        });
        Test("saved COGO coordinate and number edit", () =>
        {
            CivilDocument civil = CivilDocument.GetCivilDocument(document.Database);
            string handle = civil.CogoPoints.GetPointByPointNumber(1101).Handle.ToString();
            Apply(document, new JsonObject { ["operation"] = "cogo.edit", ["handles"] = new JsonArray(handle),
                ["elevation"] = 81 }.ToJsonString());
            EntityCheck<CogoPoint>(document, handle, point => point.Elevation == 81 && point.RawDescription == "UPDATED",
                "saved COGO edit preserves number and description");
        });
        Test("saved volume rebuild and factor edit", () =>
        {
            Apply(document, """{"operation":"volume.edit","surface":"ENG-Volume","fillFactor":1.2,"rebuild":true}""");
            JsonObject volume = ReadResult("VolumeChanges", "Get", document, "ENG-Volume");
            Check(Math.Abs(volume["adjustedFill"]!.GetValue<double>() - 6000) < 1e-5,
                "saved volume recalculates changed base geometry");
        });
        File.WriteAllText(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(
            new { passed = Passed, failure = failures.Count == 0 ? null : string.Join("\n", failures) }, Json));
    }

    [CommandMethod("MYC3DCRUDTEST")]
    public void Run()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")
            ?? throw new InvalidOperationException("전용 시험 폴더를 지정하세요.");
        Document document = App.DocumentManager.MdiActiveDocument;
        string? failure = null;
        try
        {
            _plugin = Assembly.LoadFrom(Path.Combine(folder, "MyCivil3DMcp.Plugin.dll"));
            Prepare(document);
            TestSurfaces(document);
            TestLayers(document);
            TestProfiles(document);
            JsonObject chat = JsonSerializer.SerializeToNode(Invoke("DrawingChatContext", "Read", document), Json)!.AsObject();
            Check(chat["status"]?["drawingId"]?.ToString() == Invoke("DrawingRevisions", "Id", document.Database).ToString(),
                "chat context drawing identity");
            JsonArray promptAlignments = chat["alignments"]!["items"]!.AsArray();
            Check(promptAlignments.Count > 0 && promptAlignments[0]?["profiles"] is JsonArray { Count: > 0 },
                "chat context lightweight alignment and profiles");
            TestUndo(document);
            TestDisplay(document);
            TestPrimitives(document);
            TestCreationExtensions(document);
            TestDesignExtensions(document);
            TestEngineeringObjects(document);
            TestAdvancedExtensions(document);
            TestUtilityExtensions(document);
            TestAdditionalDesignEditing(document);
            TestThirdStageExtensions(document);
            InspectViewer();
            document.Database.SaveAs(Path.Combine(folder, "extensions.dwg"), DwgVersion.Current);
        }
        catch (System.Exception error)
        {
            failure = error.ToString();
        }

        File.WriteAllText(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(new { passed = Passed, failure }, Json));
        document.Editor.WriteMessage("\nCRUD TEST: " + (failure ?? string.Join(", ", Passed)));
    }

    private static object Invoke(string type, string method, params object?[] args)
    {
        try
        {
            return _plugin!.GetType("MyCivil3DMcp.Plugin." + type)!
                .GetMethod(method, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!.Invoke(null, args)!;
        }
        catch (TargetInvocationException error)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerException ?? error).Throw();
            throw;
        }
    }

    private static JsonObject Preview(Document document, string input) =>
        JsonSerializer.SerializeToNode(Invoke("CivilPlans", "Preview", document, JsonNode.Parse(input)), Json)!.AsObject();

    private static JsonObject Apply(Document document, string input)
    {
        string trace = Path.Combine(Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!, "operations.log");
        File.AppendAllText(trace, "PREVIEW " + input + Environment.NewLine);
        JsonObject plan = Preview(document, input);
        File.AppendAllText(trace, "APPLY " + input + Environment.NewLine);
        object result = Invoke("CivilPlans", "Apply", document, new JsonObject { ["plan"] = plan });
        File.AppendAllText(trace, "DONE " + input + Environment.NewLine);
        return JsonSerializer.SerializeToNode(result, Json)!.AsObject();
    }

    private static void Check(bool condition, string name)
    {
        if (!condition)
        {
            throw new InvalidOperationException(name);
        }

        Passed.Add(name);
        File.AppendAllText(Path.Combine(Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!, "assertions.log"), name + Environment.NewLine);
    }

    private static void Reject(Action action, string name)
    {
        try
        {
            action();
        }
        catch (ArgumentException)
        {
            Passed.Add(name);
            return;
        }

        throw new InvalidOperationException("Expected rejection: " + name);
    }

    private static void Prepare(Document document)
    {
        CivilDocument civil = CivilDocument.GetCivilDocument(document.Database);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        ObjectId style = civil.Styles.AlignmentStyles.Add("CRUD-Test");
        ObjectId labels = civil.Styles.LabelSetStyles.AlignmentLabelSetStyles.Add("CRUD-Test");
        civil.Styles.SurfaceStyles.Add("CRUD-Test");
        civil.Styles.ProfileStyles.Add("CRUD-Test");
        civil.Styles.LabelSetStyles.ProfileLabelSetStyles.Add("CRUD-Test");
        ObjectId id = Alignment.Create(civil, "CRUD-Alignment", ObjectId.Null, document.Database.Clayer,
            style, labels, AlignmentType.Centerline);
        Alignment alignment = (Alignment)transaction.GetObject(id, OpenMode.ForWrite);
        alignment.Entities.AddFixedLine(new Point3d(0, 0, 0), new Point3d(100, 0, 0));
        transaction.Commit();
    }

    private static void TestSurfaces(Document document)
    {
        const string create = """
            {"operation":"surface.create","name":"CRUD-Surface","style":"CRUD-Test","points":[
            {"x":-50,"y":-50,"z":10},{"x":150,"y":-50,"z":12},{"x":0,"y":100,"z":15}]}
            """;
        JsonObject plan = Preview(document, create);
        Check(plan["kind"]!.ToString() == "create", "surface preview");
        Apply(document, create);
        Reject(() => Preview(document, create), "duplicate surface name");
        Apply(document, """
            {"operation":"surface.edit","surface":"CRUD-Surface","elevationDelta":2,"newName":"CRUD-Raised"}
            """);
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            CivilDocument civil = CivilDocument.GetCivilDocument(document.Database);
            TinSurface surface = civil.GetSurfaceIds().Cast<ObjectId>()
                .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<TinSurface>()
                .Single(item => item.Name == "CRUD-Raised");
            Check(Math.Abs(surface.FindElevationAtXY(-50, -50) - 12) < 0.001, "surface raise and rename");
        }

        Apply(document, """
            {"operation":"surface.create","name":"CRUD-Delete","style":"CRUD-Test"}
            """);
        Apply(document, """{"operation":"surface.delete","surface":"CRUD-Delete"}""");
        Passed.Add("surface delete");
        Apply(document, """
            {"operation":"surface.create","name":"CRUD-Geometry","style":"CRUD-Test","points":[
            {"x":0,"y":0,"z":10},{"x":100,"y":0,"z":10},{"x":100,"y":100,"z":10},{"x":0,"y":100,"z":10}],
            "breaklines":[[{"x":10,"y":50,"z":12},{"x":90,"y":50,"z":12}]],"boundary":[
            {"x":0,"y":0,"z":0},{"x":100,"y":0,"z":0},{"x":100,"y":100,"z":0},{"x":0,"y":100,"z":0}]}
            """);
        Apply(document, """
            {"operation":"surface.edit","surface":"CRUD-Geometry","deleteVertices":[{"x":10,"y":50}],
            "points":[{"x":25,"y":25,"z":11}],"rebuild":true}
            """);
        Passed.Add("surface breaklines, boundary, add/delete vertices and rebuild");
    }

    private static JsonObject LayerPreview(Document document, string input) =>
        JsonSerializer.SerializeToNode(Invoke("DrawingLayers", "Preview", document, JsonNode.Parse(input)), Json)!.AsObject();

    private static void EditLayer(Document document, string input)
    {
        JsonObject preview = LayerPreview(document, input);
        JsonObject item = preview["items"]![0]!.AsObject();
        Invoke("DrawingLayers", "Apply", document, new JsonObject
        {
            ["action"] = "edit", ["edits"] = new JsonArray(item.DeepClone())
        });
    }

    private static void TestLayers(Document document)
    {
        Invoke("DrawingLayers", "Apply", document, JsonNode.Parse("""
            {"action":"create","create":[{"name":"CRUD-Layer","color":3,"locked":true,"frozen":false,"off":false}]}
            """));
        ObjectId layerId;
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            LayerTable table = (LayerTable)transaction.GetObject(document.Database.LayerTableId, OpenMode.ForRead);
            layerId = table["CRUD-Layer"];
            Check(((LayerTableRecord)transaction.GetObject(layerId, OpenMode.ForRead)).IsLocked, "locked layer creation");
        }

        EditLayer(document, """{"action":"edit","names":["CRUD-Layer"],"locked":false,"frozen":true}""");
        Reject(() => Preview(document, """
            {"operation":"drawing.display","action":"selectLayer","layer":"CRUD-Layer"}
            """), "frozen layer selection rejected");
        EditLayer(document, """{"action":"edit","names":["CRUD-Layer"],"frozen":false,"off":false}""");
        Passed.Add("layer freeze, thaw, unlock");
        ObjectId lineId;
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(document.Database.CurrentSpaceId, OpenMode.ForWrite);
            using Line line = new(new Point3d(200, 0, 0), new Point3d(210, 0, 0)) { LayerId = layerId };
            lineId = space.AppendEntity(line);
            transaction.AddNewlyCreatedDBObject(line, true);
            transaction.Commit();
        }

        JsonObject blocked = LayerPreview(document, """{"action":"delete","names":["CRUD-Layer"]}""");
        Check(blocked["items"]![0]!["blocked"] is not null, "occupied layer requires object consent");
        JsonObject preview = LayerPreview(document, """
            {"action":"delete","names":["CRUD-Layer"],"deleteObjects":true}
            """);
        JsonObject item = preview["items"]![0]!.AsObject();
        Invoke("DrawingLayers", "Apply", document, new JsonObject
        {
            ["action"] = "delete", ["deleteObjects"] = true, ["targets"] = new JsonArray(item.DeepClone())
        });
        Check(lineId.IsErased && layerId.IsErased, "occupied layer and object deletion");
    }

    private static void TestProfiles(Document document)
    {
        Apply(document, """
            {"operation":"profile.create","alignment":"CRUD-Alignment","name":"CRUD-FG","type":"layout",
            "style":"CRUD-Test","labelSet":"CRUD-Test","pvis":[{"station":0,"elevation":10},
            {"station":50,"elevation":12,"curveLength":20},{"station":100,"elevation":10}]}
            """);
        Passed.Add("layout profile with curve");
        Apply(document, """
            {"operation":"profile.edit","profile":"CRUD-FG","newName":"CRUD-FG2","replacePvis":[
            {"station":0,"elevation":11},{"station":100,"elevation":13}]}
            """);
        Passed.Add("profile rename and geometry replacement");
        Apply(document, """
            {"operation":"profile.create","alignment":"CRUD-Alignment","name":"CRUD-EG","type":"surface",
            "surface":"CRUD-Raised","style":"CRUD-Test","labelSet":"CRUD-Test"}
            """);
        Passed.Add("surface profile");
        Reject(() => Preview(document, """
            {"operation":"surface.delete","surface":"CRUD-Raised"}
            """), "dependent surface deletion blocked");
        Reject(() => Preview(document, """
            {"operation":"profile.edit","profile":"CRUD-EG","replacePvis":[
            {"station":0,"elevation":1},{"station":100,"elevation":2}]}
            """), "surface profile geometry protected");
    }

    private static void TestDisplay(Document document)
    {
        Apply(document, """{"operation":"drawing.display","action":"currentLayer","layer":"0"}""");
        Passed.Add("current layer");
        ObjectId first;
        ObjectId second;
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(document.Database.CurrentSpaceId, OpenMode.ForWrite);
            using Line a = new(new Point3d(0, 200, 0), new Point3d(10, 200, 0));
            using Line b = new(new Point3d(0, 210, 0), new Point3d(10, 210, 0));
            first = space.AppendEntity(a);
            second = space.AppendEntity(b);
            transaction.AddNewlyCreatedDBObject(a, true);
            transaction.AddNewlyCreatedDBObject(b, true);
            transaction.Commit();
        }

        string handles = $"[\"{first.Handle}\"]";
        JsonObject earlierPlan = Preview(document, """
            {"operation":"surface.create","name":"CRUD-SelectionUndo","style":"CRUD-Test"}
            """);
        string earlierId = Guid.NewGuid().ToString();
        JsonObject earlierParameters = new() { ["operationId"] = earlierId, ["plan"] = earlierPlan };
        JsonObject earlierContext = new()
        {
            ["drawingId"] = (string)Invoke("DrawingRevisions", "Id", document.Database),
            ["revision"] = (string)Invoke("DrawingRevisions", "Of", document.Database)
        };
        Func<object> earlier = () => Invoke("CivilPlans", "Apply", document, earlierParameters);
        Invoke("DrawingOperations", "Apply", document, earlierParameters, earlierContext, earlier);
        JsonObject selectionPlan = Preview(document,
            "{\"operation\":\"drawing.display\",\"action\":\"select\",\"handles\":" + handles + "}");
        JsonObject selectionParameters = new() { ["operationId"] = Guid.NewGuid().ToString(), ["plan"] = selectionPlan };
        JsonObject selectionContext = new()
        {
            ["drawingId"] = (string)Invoke("DrawingRevisions", "Id", document.Database),
            ["revision"] = (string)Invoke("DrawingRevisions", "Of", document.Database)
        };
        Func<object> select = () => Invoke("CivilPlans", "Apply", document, selectionParameters);
        JsonNode selectionReceipt = JsonSerializer.SerializeToNode(Invoke("DrawingOperations", "Apply", document,
            selectionParameters, selectionContext, select), Json)!;
        Check(selectionReceipt["undoAvailable"]!.GetValue<bool>() == false, "selection has no bogus undo");
        Check(document.Editor.SelectImplied().Value.GetObjectIds().Contains(first), "object selection");
        JsonNode earlierUndo = JsonSerializer.SerializeToNode(Invoke("DrawingOperations", "Undo", document,
            new JsonObject { ["operationId"] = earlierId }), Json)!;
        Check(earlierUndo["state"]!.ToString() == "undone", "selection preserves previous edit undo");
        Apply(document, "{\"operation\":\"drawing.display\",\"action\":\"isolate\",\"handles\":" + handles + "}");
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            Check(((Line)transaction.GetObject(first, OpenMode.ForRead)).Visible
                && !((Line)transaction.GetObject(second, OpenMode.ForRead)).Visible, "same-layer object isolation");
        }

        Apply(document, """{"operation":"drawing.display","action":"restore"}""");
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            Check(((Line)transaction.GetObject(second, OpenMode.ForRead)).Visible, "isolation restore");
        }
    }

    private static void TestUndo(Document document)
    {
        JsonObject plan = Preview(document, """
            {"operation":"surface.create","name":"CRUD-Undo","style":"CRUD-Test"}
            """);
        string id = Guid.NewGuid().ToString();
        JsonObject parameters = new() { ["operationId"] = id, ["plan"] = plan };
        JsonObject context = new()
        {
            ["drawingId"] = (string)Invoke("DrawingRevisions", "Id", document.Database),
            ["revision"] = (string)Invoke("DrawingRevisions", "Of", document.Database)
        };
        Func<object> action = () => Invoke("CivilPlans", "Apply", document, parameters);
        Invoke("DrawingOperations", "Apply", document, parameters, context, action);
        JsonObject undone = JsonSerializer.SerializeToNode(Invoke("DrawingOperations", "Undo", document,
            new JsonObject { ["operationId"] = id }), Json)!.AsObject();
        Check(undone["state"]?.ToString() == "undone", "native guarded apply and undo");
    }

    private static void InspectViewer()
    {
        using ZipArchive archive = ZipFile.OpenRead(
            "C:/Program Files/Autodesk/AutoCAD 2025/C3D/UserDataCache/Support/civil.cuix");
        foreach (ZipArchiveEntry entry in archive.Entries.Where(item => item.FullName.EndsWith(".cui")
            || item.FullName.EndsWith(".xml")))
        {
            using StreamReader reader = new(entry.Open());
            string text = reader.ReadToEnd();
            foreach (Match match in Regex.Matches(text, ".{0,70}objectviewer.{0,70}", RegexOptions.IgnoreCase))
            {
                Passed.Add("Viewer macro: " + match.Value);
            }
        }
    }
}
