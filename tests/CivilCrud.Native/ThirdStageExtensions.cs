using System.Collections.Specialized;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Aec.PropertyData;
using Autodesk.Aec.PropertyData.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;
using Table = Autodesk.AutoCAD.DatabaseServices.Table;
using DataType = Autodesk.Aec.PropertyData.DataType;

namespace CivilCrud.Native;

public partial class Commands
{
    private static void TestThirdStageExtensions(Document doc)
    {
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var styles = CivilDocument.GetCivilDocument(doc.Database).Styles;
            if (styles.LabelSetStyles.AlignmentLabelSetStyles.Count == 0) styles.LabelSetStyles.AlignmentLabelSetStyles.Add("T3-AlignLabels");
            styles.LabelStyles.AlignmentLabelStyles.StationOffsetLabelStyles.Add("T3-StationOffset");
            styles.LabelStyles.ProfileViewLabelStyles.StationElevationLabelStyles.Add("T3-StationElevation");
            styles.LabelStyles.SectionViewLabelStyles.OffsetElevationLabelStyles.Add("T3-OffsetElevation");
            styles.LabelStyles.PipeLabelStyles.PlanProfileLabelStyles.Add("T3-PipeLabel");
            styles.LabelStyles.StructureLabelStyles.LabelStyles.Add("T3-StructureLabel");
            tr.Commit();
        }
        TestDependentWorkflow(doc);
        TestThirdDeletion(doc);
        TestAnalysisAndQuantities(doc);
        TestPropertySets(doc);
        TestFourthStageExtensions(doc);
        string alignmentLabel = Apply(doc, new JsonObject { ["operation"] = "label.engineering", ["kind"] = "stationOffset", ["source"] = "CRUD-Alignment", ["style"] = "T3-StationOffset", ["position"] = P(30, 5) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<StationOffsetLabel>(doc, alignmentLabel, _ => true, "actual alignment station offset label creation");
        string profileLabel = Apply(doc, new JsonObject { ["operation"] = "label.engineering", ["kind"] = "stationElevation", ["source"] = "CRUD-View-Edited", ["style"] = "T3-StationElevation", ["station"] = 30, ["elevation"] = 15 }.ToJsonString())["handle"]!.ToString();
        EntityCheck<StationElevationLabel>(doc, profileLabel, l => Math.Abs(l.Station - 30) < 1e-8, "actual profile-view station elevation label creation");
        var views = ReadResult("SectionChanges", "List", doc, new JsonObject { ["kind"] = "sectionViews" })["items"]!.AsArray();
        var view = views.Single(v => v!["name"]!.ToString() == "CRUD-Section20")!;
        double left = view["offsetLeft"]!.GetValue<double>(), right = view["offsetRight"]!.GetValue<double>();
        double min = view["elevationMin"]!.GetValue<double>(), max = view["elevationMax"]!.GetValue<double>();
        string sectionLabel = Apply(doc, new JsonObject { ["operation"] = "label.engineering", ["kind"] = "offsetElevation", ["source"] = view["handle"]!.ToString(), ["style"] = "T3-OffsetElevation", ["offset"] = (left + right) / 2, ["elevation"] = (min + max) / 2 }.ToJsonString())["handle"]!.ToString();
        EntityCheck<SectionViewOffsetElevationLabel>(doc, sectionLabel, _ => true, "actual section-view offset elevation label creation");
    }
    private static void TestDependentWorkflow(Document doc)
    {
        JsonObject Ref(string path) => new() { ["$ref"] = path };
        string linkCode;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
            linkCode = CivilDocument.GetCivilDocument(doc.Database).CorridorCollection.Cast<ObjectId>().Select(id => (Corridor)tr.GetObject(id, OpenMode.ForRead)).Single(c => c.Name == "CRUD-Corridor").GetLinkCodes().First();
        JsonObject Step(string id, JsonObject request) => new() { ["id"] = id, ["request"] = request };
        JsonObject workflow = new() { ["operation"] = "workflow.apply", ["steps"] = new JsonArray(
            Step("path", new JsonObject { ["operation"] = "geometry.create", ["kind"] = "polyline", ["points"] = new JsonArray(P(3000, 0), P(3060, 0)) }),
            Step("road", new JsonObject { ["operation"] = "alignment.fromPolyline", ["name"] = "T3-Road", ["source"] = Ref("path.created.0") }),
            Step("fg", new JsonObject { ["operation"] = "profile.create", ["name"] = "T3-FG", ["type"] = "layout", ["alignment"] = Ref("road.handle"),
                ["pvis"] = new JsonArray(new JsonObject { ["station"] = 0, ["elevation"] = 20 }, new JsonObject { ["station"] = 60, ["elevation"] = 21 }) }),
            Step("corridor", new JsonObject { ["operation"] = "corridor.create", ["name"] = "T3-Corridor", ["baselineName"] = "Main", ["alignment"] = Ref("road.handle"), ["profile"] = Ref("fg.handle"),
                ["assembly"] = "CRUD-Assembly", ["regionName"] = "R1", ["startStation"] = 0, ["endStation"] = 60 }),
            Step("top", new JsonObject { ["operation"] = "corridor.surface", ["corridor"] = Ref("corridor.handle"), ["name"] = "T3-CorridorSurface", ["linkCodes"] = new JsonArray(linkCode) })) };
        string revision = Invoke("DrawingRevisions", "Of", doc.Database)!.ToString()!;
        JsonObject first = Preview(doc, workflow.ToJsonString()), second = Preview(doc, workflow.ToJsonString());
        Check(first["fingerprint"]!.ToString() == second["fingerprint"]!.ToString(), "workflow preview deterministic despite temporary handles");
        Check(revision == Invoke("DrawingRevisions", "Of", doc.Database)!.ToString(), "workflow preview does not advance drawing revision");
        bool Exists(string name)
        {
            using Transaction tr = doc.Database.TransactionManager.StartTransaction();
            return CivilDocument.GetCivilDocument(doc.Database).GetAlignmentIds().Cast<ObjectId>().Select(id => (Alignment)tr.GetObject(id, OpenMode.ForRead)).Any(a => a.Name == name);
        }
        Check(!Exists("T3-Road"), "workflow preview rolls back all created objects");
        string undo = ApplyGuardedCivil(doc, workflow.ToJsonString());
        Check(Exists("T3-Road"), "workflow connects created alignment profile corridor and surface");
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = undo });
        Check(!Exists("T3-Road"), "workflow native Undo restores complete dependent chain");
        JsonObject bad = (JsonObject)workflow.DeepClone();
        bad["steps"]![1]!["request"]!["name"] = "T3-BadRoad";
        bad["steps"]![2]!["request"]!["pvis"]![1]!["station"] = 9999;
        Reject(() => Preview(doc, bad.ToJsonString()), "workflow rejects invalid downstream design before apply");
        Check(!Exists("T3-BadRoad"), "failed workflow simulation leaves no partial alignment");
        Apply(doc, workflow.ToJsonString());
        string poly = Apply(doc, """{"operation":"geometry.create","kind":"polyline","points":[{"x":3200,"y":0,"z":0},{"x":3240,"y":0,"z":0},{"x":3280,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        string road = Apply(doc, new JsonObject { ["operation"] = "alignment.fromPolyline", ["source"] = poly, ["name"] = "T3-EditRoad" }.ToJsonString())["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "alignment.geometry", ["alignment"] = road, ["action"] = "movePI", ["index"] = 1, ["point"] = P(3240, 10) }.ToJsonString());
        EntityCheck<Alignment>(doc, road, a => a.Length > 80, "alignment fixed-line PI edit keeps handle and changes geometry");
        Apply(doc, new JsonObject { ["operation"] = "alignment.geometry", ["alignment"] = road, ["action"] = "appendLine", ["point"] = P(3300, 0) }.ToJsonString());
        Apply(doc, new JsonObject { ["operation"] = "alignment.geometry", ["alignment"] = road, ["action"] = "appendArc", ["midPoint"] = P(3310, 10), ["point"] = P(3320, 0) }.ToJsonString());
        EntityCheck<Alignment>(doc, road, a => a.Entities.Count == 4, "alignment terminal line and three-point arc creation");
        Apply(doc, new JsonObject { ["operation"] = "alignment.geometry", ["alignment"] = road, ["action"] = "removeLast" }.ToJsonString());
        EntityCheck<Alignment>(doc, road, a => a.Entities.Count == 3, "alignment terminal element removal");
    }
    private static void TestThirdDeletion(Document doc)
    {
        string line = Apply(doc, """{"operation":"geometry.create","kind":"line","points":[{"x":3500,"y":0,"z":0},{"x":3520,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        string feature = Apply(doc, new JsonObject { ["operation"] = "featureLine.create", ["name"] = "T3-DeleteFeature", ["source"] = line }.ToJsonString())["handle"]!.ToString();
        string undo = ApplyGuardedCivil(doc, new JsonObject { ["operation"] = "civilObject.delete", ["kind"] = "featureLine", ["handles"] = new JsonArray(feature) }.ToJsonString());
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = undo });
        EntityCheck<FeatureLine>(doc, feature, _ => true, "feature-line deletion native Undo restores source");
        string group = Apply(doc, """{"operation":"sampleGroup.create","name":"T3-DeleteSamples","alignment":"CRUD-Alignment"}""")["handle"]!.ToString();
        string sample = Apply(doc, new JsonObject { ["operation"] = "sampleLine.create", ["group"] = group, ["name"] = "T3-DeleteSample", ["points"] = new JsonArray(P(70, -20), P(70, 20)) }.ToJsonString())["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "sectionView.create", ["sampleLine"] = sample, ["name"] = "T3-DeleteView", ["position"] = P(3500, -300) }.ToJsonString());
        JsonObject deletion = new() { ["operation"] = "civilObject.delete", ["kind"] = "sampleGroup", ["handles"] = new JsonArray(group) };
        Reject(() => Preview(doc, deletion.ToJsonString()), "sample-group deletion requires explicit owned-dependents consent");
        deletion["includeDependents"] = true; Apply(doc, deletion.ToJsonString());
        Check(!ReadResult("SectionChanges", "List", doc, new JsonObject { ["kind"] = "sampleGroups" })["items"]!.AsArray().Any(g => g!["name"]!.ToString() == "T3-DeleteSamples"), "sample-group deletion removes owned sample lines and views");
        string size;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var civil = CivilDocument.GetCivilDocument(doc.Database);
            var network = civil.GetPressurePipeNetworkIds().Cast<ObjectId>().Select(id => (PressurePipeNetwork)tr.GetObject(id, OpenMode.ForRead)).Single(n => n.Name == "CRUD-Pressure");
            size = ((PressurePartList)tr.GetObject(network.PartsListId, OpenMode.ForRead)).GetParts(PressurePartDomainType.Pipe).First(s => s.IsValid).PartSizeGuid;
        }
        string path = Apply(doc, """{"operation":"geometry.create","kind":"polyline","points":[{"x":3800,"y":0,"z":0},{"x":3820,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "pressureRun.create", ["network"] = "CRUD-Pressure", ["name"] = "T3-DeleteRun", ["source"] = path, ["sizeGuid"] = size, ["cover"] = 1.2 }.ToJsonString());
        Apply(doc, """{"operation":"pressureRun.delete","network":"CRUD-Pressure","run":"T3-DeleteRun","removeParts":true,"removePath":true}""");
        Check(ReadResult("PressureRunChanges", "List", doc, new JsonObject { ["network"] = "CRUD-Pressure" })["total"]!.GetValue<int>() == 1, "pressure run deletion removes owned run and preserves original run");
        string part = Apply(doc, new JsonObject { ["operation"] = "pressurePart.create", ["network"] = "CRUD-Pressure", ["name"] = "T3-DeletePart", ["kind"] = "Pipe", ["sizeGuid"] = size,
            ["start"] = P(3850, 0, -2), ["end"] = P(3870, 0, -2) }.ToJsonString())["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "civilObject.delete", ["kind"] = "pressurePart", ["handles"] = new JsonArray(part) }.ToJsonString());
        Check(!ReadResult("PressureChanges", "List", doc, new JsonObject { ["network"] = "CRUD-Pressure" })["items"]!.AsArray().Any(p => p!["handle"]!.ToString() == part), "individual pressure part deletion updates network membership");
        string catchmentGroup;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
            catchmentGroup = CatchmentGroupCollection.GetCatchmentGroups(doc.Database).Cast<ObjectId>().Select(id => (CatchmentGroup)tr.GetObject(id, OpenMode.ForRead))
                .First(g => g.GetAllCatchmentIds().Cast<ObjectId>().Any(id => ((Catchment)tr.GetObject(id, OpenMode.ForRead)).Name == "EXT-Catchment")).Handle.ToString();
        string catchment = Apply(doc, new JsonObject { ["operation"] = "catchment.create", ["name"] = "T3-DeleteCatchment", ["group"] = catchmentGroup, ["surface"] = "EXT-Surface",
            ["points"] = new JsonArray(P(2060, 60), P(2090, 60), P(2090, 90), P(2060, 90)) }.ToJsonString())["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "civilObject.delete", ["kind"] = "catchment", ["handles"] = new JsonArray(catchment) }.ToJsonString());
        Check(!ReadResult("CatchmentChanges", "List", doc, new JsonObject { ["group"] = catchmentGroup })["items"]!.AsArray().Any(c => c!["handle"]!.ToString() == catchment), "catchment deletion updates group membership");
    }
    private static void TestAnalysisAndQuantities(Document doc)
    {
        Apply(doc, new JsonObject { ["operation"] = "surface.analysis", ["surface"] = "EXT-Surface", ["kind"] = "elevation", ["bands"] = new JsonArray(
            new JsonObject { ["min"] = 10, ["max"] = 15, ["color"] = 1 }, new JsonObject { ["min"] = 15, ["max"] = 20, ["color"] = 3 }) }.ToJsonString());
        Check(ReadResult("SurfaceAnalysisChanges", "List", doc, new JsonObject { ["surface"] = "EXT-Surface" })["analysis"]!["elevations"]!.AsArray().Count == 2, "surface elevation analysis stores exact bands");
        Apply(doc, new JsonObject { ["operation"] = "surface.analysis", ["surface"] = "EXT-Surface", ["kind"] = "slope", ["bands"] = new JsonArray(new JsonObject { ["min"] = 0, ["max"] = 0.2, ["color"] = 4 }) }.ToJsonString());
        Check(Apply(doc, new JsonObject { ["operation"] = "surface.waterdrop", ["surface"] = "EXT-Surface", ["point"] = P(2080, 50) }.ToJsonString())["created"]!.AsArray().Count > 0, "native waterdrop creates actual 3D flow path");
        string line = Apply(doc, """{"operation":"geometry.create","kind":"line","points":[{"x":3600,"y":0,"z":0},{"x":3610,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        string table = Apply(doc, new JsonObject { ["operation"] = "quantityTable.create", ["handles"] = new JsonArray(line), ["metric"] = "length", ["position"] = P(3600, -100), ["rowHeight"] = 5, ["columnWidth"] = 30, ["height"] = 2 }.ToJsonString())["handle"]!.ToString();
        EntityCheck<Table>(doc, table, t => t.Cells[1, 2].TextString == "10", "quantity table reads actual source geometry");
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var l = (Line)tr.GetObject(doc.Database.GetObjectId(false, new Handle(Convert.ToInt64(line, 16)), 0), OpenMode.ForWrite); l.EndPoint = new Point3d(3620, 0, 0); tr.Commit();
        }
        Apply(doc, new JsonObject { ["operation"] = "quantityTable.refresh", ["table"] = table }.ToJsonString());
        EntityCheck<Table>(doc, table, t => t.Cells[1, 2].TextString == "20", "quantity table explicit refresh uses saved source handles");
    }
    private static void TestPropertySets(Document doc)
    {
        string definition;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var dictionary = new DictionaryPropertySetDefinitions(doc.Database);
            var d = new PropertySetDefinition(); d.SetToStandard(doc.Database); d.SubSetDatabaseDefaults(doc.Database);
            d.SetAppliesToFilter(new StringCollection { "AcDbLine" }, false);
            d.Definitions.Add(new PropertyDefinition { Name = "Code", DataType = DataType.Text, DefaultData = "" });
            d.Definitions.Add(new PropertyDefinition { Name = "Amount", DataType = DataType.Real, DefaultData = 0.0 });
            dictionary.AddNewRecord("T3-Properties", d); tr.AddNewlyCreatedDBObject(d, true); definition = d.Handle.ToString(); tr.Commit();
        }
        string source = Apply(doc, """{"operation":"geometry.create","kind":"line","points":[{"x":3700,"y":0,"z":0},{"x":3720,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "propertySet.change", ["action"] = "attach", ["definition"] = definition, ["handles"] = new JsonArray(source) }.ToJsonString());
        Apply(doc, new JsonObject { ["operation"] = "propertySet.change", ["action"] = "set", ["definition"] = definition, ["handles"] = new JsonArray(source), ["values"] = new JsonObject { ["Code"] = "측량-01", ["Amount"] = 12.5 } }.ToJsonString());
        var sets = ReadResult("PropertySetChanges", "List", doc, new JsonObject { ["handle"] = source })["sets"]![0]!["values"]!.AsArray();
        Check(sets.Single(v => v!["name"]!.ToString() == "Code")!["value"]!.ToString() == "측량-01" && sets.Single(v => v!["name"]!.ToString() == "Amount")!["value"]!.GetValue<double>() == 12.5, "property-set attachment and typed manual values use actual AEC data");
        Apply(doc, new JsonObject { ["operation"] = "propertySet.change", ["action"] = "detach", ["definition"] = definition, ["handles"] = new JsonArray(source) }.ToJsonString());
        Check(ReadResult("PropertySetChanges", "List", doc, new JsonObject { ["handle"] = source })["sets"]!.AsArray().Count == 0, "property-set detachment removes assigned data");
    }
}
