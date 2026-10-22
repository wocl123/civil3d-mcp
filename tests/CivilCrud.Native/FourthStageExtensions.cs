using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Aec.PropertyData.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using System.IO;
using System.Text.Json;

namespace CivilCrud.Native;

public partial class Commands
{
    private static void TestFourthStageExtensions(Document doc)
    {
        JsonObject Field(string name, string type, JsonNode value) => new() { ["name"] = name, ["type"] = type, ["default"] = value };
        JsonObject definition = new() { ["operation"] = "propertyDefinition.change", ["action"] = "create", ["name"] = "T4-Properties",
            ["appliesTo"] = new JsonArray("AcDbLine"), ["properties"] = new JsonArray(Field("Code", "Text", JsonValue.Create("init")!), Field("Count", "Integer", JsonValue.Create(3)!)) };
        string revision = Invoke("DrawingRevisions", "Of", doc.Database)!.ToString()!;
        Preview(doc, definition.ToJsonString());
        Check(Invoke("DrawingRevisions", "Of", doc.Database)!.ToString() == revision && !ReadResult("PropertySetChanges", "List", doc, new JsonObject())["items"]!.AsArray().Any(d => d!["name"]!.ToString() == "T4-Properties"), "property definition preview creates nothing");
        string undo = ApplyGuardedCivil(doc, definition.ToJsonString());
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = undo });
        Check(!ReadResult("PropertySetChanges", "List", doc, new JsonObject())["items"]!.AsArray().Any(d => d!["name"]!.ToString() == "T4-Properties"), "property definition creation native Undo");
        string def = Apply(doc, definition.ToJsonString())["handle"]!.ToString();
        string source = Apply(doc, """{"operation":"geometry.create","kind":"line","points":[{"x":4000,"y":0,"z":0},{"x":4020,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "propertySet.change", ["action"] = "attach", ["definition"] = def, ["handles"] = new JsonArray(source) }.ToJsonString());
        Apply(doc, new JsonObject { ["operation"] = "propertySet.change", ["action"] = "set", ["definition"] = def, ["handles"] = new JsonArray(source), ["values"] = new JsonObject { ["Code"] = "preserved" } }.ToJsonString());
        JsonObject add = new() { ["operation"] = "propertyDefinition.change", ["action"] = "add", ["name"] = "T4-Properties", ["properties"] = new JsonArray(Field("Active", "TrueFalse", JsonValue.Create(true)!), Field("Amount", "Real", JsonValue.Create(12.5)!)) };
        Apply(doc, add.ToJsonString());
        var values = ReadResult("PropertySetChanges", "List", doc, new JsonObject { ["handle"] = source })["sets"]![0]!["values"]!.AsArray();
        Check(values.Single(v => v!["name"]!.ToString() == "Code")!["value"]!.ToString() == "preserved" && values.Single(v => v!["name"]!.ToString() == "Amount")!["value"]!.GetValue<double>() == 12.5, "property schema expansion synchronizes defaults and preserves manual data");
        Reject(() => Preview(doc, add.ToJsonString()), "property schema rejects duplicate field instead of overwriting");
        TestPropertyWorkflow(doc);
        TestSuperelevation(doc);
    }
    private static void TestPropertyWorkflow(Document doc)
    {
        JsonObject Ref(string path) => new() { ["$ref"] = path };
        JsonObject Step(string id, JsonObject request) => new() { ["id"] = id, ["request"] = request };
        JsonObject workflow = new() { ["operation"] = "workflow.apply", ["steps"] = new JsonArray(
            Step("line", new JsonObject { ["operation"] = "geometry.create", ["kind"] = "line", ["points"] = new JsonArray(P(4050, 0), P(4070, 0)) }),
            Step("schema", new JsonObject { ["operation"] = "propertyDefinition.change", ["action"] = "create", ["name"] = "T4-WorkflowSchema", ["appliesTo"] = new JsonArray("AcDbLine"),
                ["properties"] = new JsonArray(new JsonObject { ["name"] = "Code", ["type"] = "Text", ["default"] = "" }) }),
            Step("attach", new JsonObject { ["operation"] = "propertySet.change", ["action"] = "attach", ["definition"] = Ref("schema.handle"), ["handles"] = new JsonArray(Ref("line.created.0")) }),
            Step("value", new JsonObject { ["operation"] = "propertySet.change", ["action"] = "set", ["definition"] = Ref("schema.handle"), ["handles"] = new JsonArray(Ref("line.created.0")), ["values"] = new JsonObject { ["Code"] = "one-call" } })) };
        JsonObject first = Preview(doc, workflow.ToJsonString()), second = Preview(doc, workflow.ToJsonString());
        Check(first["fingerprint"]!.ToString() == second["fingerprint"]!.ToString(), "property workflow preview deterministic and rolls back schema");
        var result = Apply(doc, workflow.ToJsonString());
        string line = result["steps"]![0]!["result"]!["created"]![0]!.ToString();
        Check(ReadResult("PropertySetChanges", "List", doc, new JsonObject { ["handle"] = line })["sets"]![0]!["values"]![0]!["value"]!.ToString() == "one-call", "one workflow creates geometry schema attachment and typed value");
    }
    private static void TestSuperelevation(Document doc)
    {
        string poly = Apply(doc, """{"operation":"geometry.create","kind":"polyline","points":[{"x":4100,"y":0,"z":0},{"x":4200,"y":0,"z":0},{"x":4300,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        string road = Apply(doc, new JsonObject { ["operation"] = "alignment.fromPolyline", ["source"] = poly, ["name"] = "T4-SuperRoad" }.ToJsonString())["handle"]!.ToString();
        int first, last;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var a = (Alignment)tr.GetObject(doc.Database.GetObjectId(false, new Handle(Convert.ToInt64(road, 16)), 0), OpenMode.ForRead);
            first = a.Entities.FirstEntity; last = a.Entities.LastEntity;
        }
        JsonObject curve = new() { ["operation"] = "alignment.superelevation", ["alignment"] = road, ["action"] = "createCurve", ["startEntityId"] = first, ["endEntityId"] = last };
        string revision = Invoke("DrawingRevisions", "Of", doc.Database)!.ToString()!;
        Preview(doc, curve.ToJsonString());
        Check(Invoke("DrawingRevisions", "Of", doc.Database)!.ToString() == revision, "superelevation preview rolls back cache initialization");
        var created = Apply(doc, curve.ToJsonString());
        string name = created["curves"]![0]!["name"]!.ToString();
        JsonObject edit = new() { ["operation"] = "alignment.superelevation", ["alignment"] = road, ["action"] = "addStation", ["curve"] = name, ["station"] = 50,
            ["slopes"] = new JsonObject { ["LeftOutLaneCrossSlope"] = -0.04, ["RightOutLaneCrossSlope"] = 0.04 } };
        var added = Apply(doc, edit.ToJsonString());
        Check(added["curves"]![0]!["stations"]!.AsArray().Any(s => s!["station"]!.GetValue<double>() == 50 && s["slopes"]!["LeftOutLaneCrossSlope"]!.GetValue<double>() == -0.04), "native superelevation manual station and lane slopes");
        edit["action"] = "setSlopes"; edit["slopes"] = new JsonObject { ["LeftOutLaneCrossSlope"] = -0.06 };
        string undo = ApplyGuardedCivil(doc, edit.ToJsonString());
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = undo });
        var restored = Preview(doc, edit.ToJsonString());
        Check(restored["request"]!["sourceState"]![0]!["stations"]!.AsArray().Any(s => s!["station"]!.GetValue<double>() == 50 && s["slopes"]!["LeftOutLaneCrossSlope"]!.GetValue<double>() == -0.04), "superelevation slope update native Undo restores prior values");
        Apply(doc, edit.ToJsonString());
        edit["action"] = "removeStation"; Apply(doc, edit.ToJsonString());
        edit["action"] = "addStation"; Apply(doc, edit.ToJsonString());
        edit["station"] = 9999; Reject(() => Preview(doc, edit.ToJsonString()), "superelevation rejects out of range station");
        JsonObject table = new() { ["operation"] = "alignment.superelevation", ["alignment"] = road, ["action"] = "setTable", ["curve"] = name,
            ["stations"] = new JsonArray(new JsonObject { ["station"] = 50, ["slopes"] = new JsonObject { ["LeftOutLaneCrossSlope"] = -0.06 } },
                new JsonObject { ["station"] = 100, ["slopes"] = new JsonObject { ["LeftOutLaneCrossSlope"] = -0.05, ["RightOutLaneCrossSlope"] = 0.05 } }) };
        var bulk = Apply(doc, table.ToJsonString());
        Check(bulk["curves"]![0]!["stations"]!.AsArray().Any(s => s!["station"]!.GetValue<double>() == 100 && Math.Abs(s["slopes"]!["RightOutLaneCrossSlope"]!.GetValue<double>() - 0.05) < 1e-8), "superelevation table upserts multiple stations in one operation");
        table["stations"]![1]!["station"] = 50;
        Reject(() => Preview(doc, table.ToJsonString()), "superelevation table rejects duplicate stations atomically");
    }
    private static void TestParcelAutomation(Document doc)
    {
        string source = Apply(doc, """{"operation":"geometry.create","kind":"polyline","closed":true,"points":[{"x":4400,"y":0,"z":0},{"x":4440,"y":0,"z":0},{"x":4440,"y":30,"z":0},{"x":4400,"y":30,"z":0}]}""")["created"]![0]!.ToString();
        JsonObject create = new() { ["operation"] = "parcel.create", ["source"] = source, ["siteName"] = "T4-ParcelSite" };
        Preview(doc, create.ToJsonString());
        Check(ReadResult("ParcelChanges", "List", doc, new JsonObject())["total"]!.GetValue<int>() == 0, "parcel preview creates no topology");
        using (Transaction temporary = doc.Database.TransactionManager.StartTransaction())
        {
            Apply(doc, create.ToJsonString()); temporary.Abort();
        }
        Check(ReadResult("ParcelChanges", "List", doc, new JsonObject())["total"]!.GetValue<int>() == 0, "COM parcel creation rolls back in outer transaction");
        string undo = ApplyGuardedCivil(doc, create.ToJsonString());
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = undo });
        Check(ReadResult("ParcelChanges", "List", doc, new JsonObject())["total"]!.GetValue<int>() == 0, "COM parcel creation native Undo restores Site topology");
        string parcel = Apply(doc, create.ToJsonString())["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "parcel.edit", ["parcel"] = parcel, ["address"] = "자동화 검증", ["taxId"] = 42 }.ToJsonString());
        Check(ReadResult("ParcelChanges", "List", doc, new JsonObject())["items"]![0]!["address"]!.ToString() == "자동화 검증", "real Civil parcel create and metadata edit");
        EntityCheck<Polyline>(doc, source, p => p.Closed && Math.Abs(p.Area - 1200) < 1e-7, "parcel creation preserves original boundary");
        Reject(() => Preview(doc, create.ToJsonString()), "parcel creation rejects existing Site topology");
    }
    [CommandMethod("MYC3DPARCELAUTOTEST")]
    public void ParcelAutomationGui()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        string? failure = null;
        try
        {
            string expected = Path.Combine(folder, "MyCivil3DMcp.Plugin.dll");
            var loaded = AppDomain.CurrentDomain.GetAssemblies().Where(a => a.GetName().Name == "MyCivil3DMcp.Plugin").ToArray();
            if (loaded.Length > 1) throw new InvalidOperationException("플러그인 DLL이 중복 로드되어 검사를 중단합니다.");
            if (loaded.Length == 1)
            {
                string Hash(string file) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(file)));
                if (Hash(loaded[0].Location) != Hash(expected)) throw new InvalidOperationException("설치 DLL과 현재 빌드가 다릅니다. 내부배포 후 검사하세요.");
                _plugin = loaded[0]; // Use the identical installed build; never load a second development DLL.
            }
            else _plugin = System.Reflection.Assembly.LoadFrom(expected);
            Invoke("DrawingRevisions", "Start");
            Document doc = Autodesk.AutoCAD.ApplicationServices.Application.DocumentManager.MdiActiveDocument;
            TestParcelAutomation(doc);
            doc.Database.SaveAs(Path.Combine(folder, "parcel-automation.dwg"), DwgVersion.Current);
        }
        catch (System.Exception e) { failure = e.ToString(); }
        File.WriteAllText(Path.Combine(folder, "parcel-automation.json"), JsonSerializer.Serialize(new { passed = Passed, failure }, Json));
    }
    [CommandMethod("MYC3DPARCELREOPEN")]
    public void ParcelAutomationReopen()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        string? failure = null;
        try
        {
            Document doc = Autodesk.AutoCAD.ApplicationServices.Application.DocumentManager.MdiActiveDocument;
            using Transaction tr = doc.Database.TransactionManager.StartTransaction();
            var civil = CivilDocument.GetCivilDocument(doc.Database);
            var site = civil.GetSiteIds().Cast<ObjectId>().Select(id => (Site)tr.GetObject(id, OpenMode.ForRead)).Single(s => s.Name == "T4-ParcelSite");
            var parcel = (Parcel)tr.GetObject(site.GetParcelIds()[0], OpenMode.ForRead);
            Check(site.GetParcelIds().Count == 1 && parcel.Address == "자동화 검증" && parcel.TaxId == 42, "reopened Civil COM parcel retains topology and metadata");
        }
        catch (System.Exception e) { failure = e.ToString(); }
        File.WriteAllText(Path.Combine(folder, "parcel-reopen.json"), JsonSerializer.Serialize(new { passed = Passed, failure }, Json));
    }
}
