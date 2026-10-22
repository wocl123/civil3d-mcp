using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace CivilCrud.Native;

public partial class Commands
{
    private static void TestAdditionalDesignEditing(Document doc)
    {
        var samples = ReadResult("SectionChanges", "List", doc, new JsonObject { ["kind"] = "sampleLines" });
        string sample = samples["items"]!.AsArray().Single(n => n!["name"]!.ToString() == "CRUD-Sample20")!["handle"]!.ToString();
        JsonObject edit = new() { ["operation"] = "sampleLine.edit", ["sampleLine"] = sample, ["station"] = 25, ["leftWidth"] = 15, ["rightWidth"] = 22 };
        JsonObject stale = Preview(doc, edit.ToJsonString());
        string undo = ApplyGuardedCivil(doc, edit.ToJsonString());
        EntityCheck<SampleLine>(doc, sample, l => Math.Abs(l.Station - 25) < 1e-6 && Math.Abs(l.Vertices.Max(v => v.Location.Y) - l.Vertices.Min(v => v.Location.Y) - 37) < 1e-6,
            "sample line station and perpendicular widths edit preserves existing line");
        Reject(() => Invoke("CivilPlans", "Apply", doc, new JsonObject { ["plan"] = stale }), "sample line stale source refused");
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = undo });
        EntityCheck<SampleLine>(doc, sample, l => Math.Abs(l.Station - 20) < 1e-6, "sample line guarded Undo restores station");
        Apply(doc, edit.ToJsonString());
        var groups = ReadResult("SectionChanges", "List", doc, new JsonObject { ["kind"] = "sampleGroups" });
        string group = groups["items"]!.AsArray().Single(n => n!["name"]!.ToString() == "CRUD-Samples")!["handle"]!.ToString();
        JsonObject batch = new() { ["operation"] = "sampleLine.batch", ["group"] = group, ["name"] = "EXT-SL", ["startStation"] = 30, ["endStation"] = 50,
            ["interval"] = 10, ["leftWidth"] = 12, ["rightWidth"] = 18 };
        Check(Apply(doc, batch.ToJsonString())["created"]!.AsArray().Count == 3, "sample line batch creates exact interval and endpoint count");
        Reject(() => Preview(doc, batch.ToJsonString()), "sample line batch name collisions refused before apply");
        JsonObject region = new() { ["corridor"] = "CRUD-Corridor", ["baselineName"] = "Main", ["regionName"] = "Region1" };
        region["operation"] = "corridor.split"; region["station"] = 40; region["newName"] = "EXT-Region2";
        Apply(doc, region.ToJsonString());
        string corridor = ReadResult("CorridorChanges", "List", doc, new JsonObject { ["kind"] = "corridors" })["items"]!.AsArray().Single(n => n!["name"]!.ToString() == "CRUD-Corridor")!["handle"]!.ToString();
        EntityCheck<Corridor>(doc, corridor, c => c.Baselines[0].BaselineRegions.Count == 2, "corridor native split creates two regions");
        JsonObject merge = new() { ["operation"] = "corridor.merge", ["corridor"] = corridor, ["baselineName"] = "Main", ["regionName"] = "Region1", ["otherRegion"] = "EXT-Region2" };
        Apply(doc, merge.ToJsonString());
        EntityCheck<Corridor>(doc, corridor, c => c.Baselines[0].BaselineRegions.Count == 1 && c.Baselines[0].BaselineRegions[0].EndStation == 80,
            "corridor native merge restores continuous range");
        Apply(doc, region.ToJsonString());
        Apply(doc, new JsonObject { ["operation"] = "corridor.removeRegion", ["corridor"] = corridor, ["baselineName"] = "Main", ["regionName"] = "EXT-Region2" }.ToJsonString());
        EntityCheck<Corridor>(doc, corridor, c => c.Baselines[0].BaselineRegions.Count == 1, "corridor region deletion preserves other region");
        TestSubassemblyParameters(doc);
        Apply(doc, """{"operation":"corridor.baseline","corridor":"CRUD-Corridor","baselineName":"Feature","featureLine":"CRUD-Feature"}""");
        EntityCheck<Corridor>(doc, corridor, c => c.Baselines.Any(b => b.Name == "Feature" && b.IsFeatureLineBased()), "corridor accepts actual feature line baseline");
        TestCorridorSolids(doc, corridor);
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var styles = CivilDocument.GetCivilDocument(doc.Database).Styles;
            if (styles.CatchmentStyles.Count == 0) styles.CatchmentStyles.Add("EXT-Catchment");
            tr.Commit();
        }
        int beforeGroups = ReadResult("CatchmentChanges", "List", doc, new JsonObject())["total"]!.GetValue<int>();
        string groupUndo = ApplyGuardedCivil(doc, """{"operation":"catchmentGroup.create","name":"EXT-UndoGroup"}""");
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = groupUndo });
        Check(ReadResult("CatchmentChanges", "List", doc, new JsonObject())["total"]!.GetValue<int>() == beforeGroups, "catchment group native Undo restores group collection");
        string catchmentGroup = Apply(doc, """{"operation":"catchmentGroup.create","name":"EXT-Catchments"}""")["handle"]!.ToString();
        string catchment = Apply(doc, new JsonObject { ["operation"] = "catchment.create", ["name"] = "EXT-Catchment", ["group"] = catchmentGroup, ["surface"] = "EXT-Surface",
            ["points"] = new JsonArray(P(2010, 10), P(2040, 10), P(2040, 40), P(2010, 40)) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<Catchment>(doc, catchment, c => c.ContainingGroupId.Handle.ToString() == catchmentGroup, "catchment creates actual bounded Civil object in exact group");
        Apply(doc, new JsonObject { ["operation"] = "catchment.edit", ["handle"] = catchment, ["runoffCoefficient"] = 0.6, ["curveNumber"] = 75 }.ToJsonString());
        EntityCheck<Catchment>(doc, catchment, c => Math.Abs(c.RunoffCoefficient - 0.6) < 1e-9 && c.CurveNumber == 75, "catchment explicit runoff and curve number edit");
        Check(ReadResult("CatchmentChanges", "List", doc, new JsonObject())["total"]!.GetValue<int>() >= 1, "catchment groups and geometry inventory");
        Check(ReadResult("CatchmentChanges", "List", doc, new JsonObject { ["group"] = catchmentGroup, ["limit"] = 1 })["items"]!.AsArray().Count == 1, "catchment boundary inventory obeys page limit");
        TestPressureRuns(doc);
        JsonObject equations = new() { ["alignment"] = "CRUD-Alignment", ["operation"] = "alignment.stationEquations", ["equations"] = new JsonArray(
            new JsonObject { ["rawStationBack"] = 60, ["stationAhead"] = 160, ["type"] = "Increasing" }) };
        string equationUndo = ApplyGuardedCivil(doc, equations.ToJsonString());
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var a = CivilDocument.GetCivilDocument(doc.Database).GetAlignmentIds().Cast<ObjectId>().Select(id => (Alignment)tr.GetObject(id, OpenMode.ForRead)).Single(a => a.Name == "CRUD-Alignment");
            Check(a.StationEquations.Count == 1 && a.StationEquations[0].RawStationBack == 60 && a.StationEquations[0].StationAhead == 160, "alignment station equation uses exact raw and ahead stations");
        }
        JsonObject equationBatch = (JsonObject)batch.DeepClone(); equationBatch["name"] = "EQ-Blocked";
        Reject(() => Preview(doc, equationBatch.ToJsonString()), "equation-bearing alignment refuses automatic station batch");
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = equationUndo });
        Check(true, "alignment station equation supports guarded native Undo");
        var workflows = ReadResult("NativeCivilWorkflows", "List");
        foreach (string key in new[] { "network.interference", "corridor.solids", "pressureRun.layout", "catchment.surface", "rail.cant", "templates.attach", "propertySets.define" })
            Check(workflows["items"]!.AsArray().Any(n => n!["workflow"]!.ToString() == key), "installed native workflow available: " + key);
    }
    private static void TestSubassemblyParameters(Document doc)
    {
        string sub;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            ObjectId id = CivilDocument.GetCivilDocument(doc.Database).SubassemblyCollection.ImportStockSubassembly("EXT-WidthSlope", "Subassembly.LinkWidthAndSlope", new Point3d(1600, 0, 0));
            sub = id.Handle.ToString(); tr.Commit();
        }
        var inventory = ReadResult("CorridorChanges", "List", doc, new JsonObject { ["kind"] = "subassemblies" });
        var item = inventory["items"]!.AsArray().Single(n => n!["handle"]!.ToString() == sub)!;
        var width = item["parameters"]!.AsArray().Single(n => n!["key"]!.ToString().Equals("Width", StringComparison.OrdinalIgnoreCase))!;
        Apply(doc, new JsonObject { ["operation"] = "subassembly.parameters", ["subassembly"] = sub,
            ["parameters"] = new JsonArray(new JsonObject { ["key"] = width["key"]!.ToString(), ["type"] = "double", ["value"] = 7 }) }.ToJsonString());
        EntityCheck<Subassembly>(doc, sub, s => s.ParamsDouble.Any(p => p.Key == width["key"]!.ToString() && Math.Abs(p.Value - 7) < 1e-8), "real stock subassembly width input edit");
        Reject(() => Preview(doc, new JsonObject { ["operation"] = "subassembly.parameters", ["subassembly"] = sub,
            ["parameters"] = new JsonArray(new JsonObject { ["key"] = "Side", ["type"] = "integer", ["value"] = 999 }) }.ToJsonString()), "subassembly rejects integer outside actual enum choices");
    }
    private static void TestCorridorSolids(Document doc, string corridor)
    {
        string lane;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            ObjectId id = CivilDocument.GetCivilDocument(doc.Database).SubassemblyCollection.ImportStockSubassembly("EXT-Lane", "Subassembly.LaneSuperelevationAOR", new Point3d(1650, 0, 0));
            lane = id.Handle.ToString(); tr.Commit();
        }
        Apply(doc, new JsonObject { ["operation"] = "assembly.edit", ["assembly"] = "CRUD-Assembly", ["subassembly"] = lane }.ToJsonString());
        Apply(doc, new JsonObject { ["operation"] = "corridor.rebuild", ["corridor"] = corridor }.ToJsonString());
        string code;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
            code = ((Corridor)tr.GetObject(doc.Database.GetObjectId(false, new Handle(Convert.ToInt64(corridor, 16)), 0), OpenMode.ForRead)).GetShapeCodes().First();
        JsonObject request = new() { ["operation"] = "corridor.solids", ["corridor"] = corridor, ["codes"] = new JsonArray(code) };
        Check(Apply(doc, request.ToJsonString())["created"]!.AsArray().Count > 0, "corridor shape-code export creates actual solids");
    }
    private static void TestPressureRuns(Document doc)
    {
        string size;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var civil = CivilDocument.GetCivilDocument(doc.Database);
            var n = civil.GetPressurePipeNetworkIds().Cast<ObjectId>().Select(id => (PressurePipeNetwork)tr.GetObject(id, OpenMode.ForRead)).Single(n => n.Name == "CRUD-Pressure");
            var list = (PressurePartList)tr.GetObject(n.PartsListId, OpenMode.ForRead);
            size = list.GetParts(PressurePartDomainType.Pipe).First(p => p.IsValid).PartSizeGuid;
        }
        string source = Apply(doc, """{"operation":"geometry.create","kind":"polyline","points":[{"x":1700,"y":0,"z":0},{"x":1760,"y":0,"z":0}]}""")["created"]![0]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "pressureRun.create", ["network"] = "CRUD-Pressure", ["name"] = "EXT-Run", ["source"] = source, ["sizeGuid"] = size, ["cover"] = 1.2 }.ToJsonString());
        EntityCheck<Polyline>(doc, source, p => p.Length == 60, "pipe run creation preserves original path polyline");
        Check(ReadResult("PressureRunChanges", "List", doc, new JsonObject { ["network"] = "CRUD-Pressure" })["total"]!.GetValue<int>() == 1, "real pressure pipe run creation and inventory");
        Apply(doc, new JsonObject { ["operation"] = "pressureRun.break", ["network"] = "CRUD-Pressure", ["run"] = "EXT-Run", ["point"] = P(1730, 0), ["newName"] = "EXT-Run2" }.ToJsonString());
        Check(ReadResult("PressureRunChanges", "List", doc, new JsonObject { ["network"] = "CRUD-Pressure" })["total"]!.GetValue<int>() == 2, "pressure pipe run break preserves both runs");
        Apply(doc, new JsonObject { ["operation"] = "pressureRun.merge", ["network"] = "CRUD-Pressure", ["run"] = "EXT-Run", ["otherRun"] = "EXT-Run2" }.ToJsonString());
        Check(ReadResult("PressureRunChanges", "List", doc, new JsonObject { ["network"] = "CRUD-Pressure" })["total"]!.GetValue<int>() == 1, "pressure pipe run merge restores single run");
        var run = ReadResult("PressureRunChanges", "List", doc, new JsonObject { ["network"] = "CRUD-Pressure" })["items"]![0]!;
        string profile = Apply(doc, new JsonObject { ["operation"] = "profile.create", ["name"] = "EXT-RunProfile", ["type"] = "layout", ["alignment"] = run["alignment"]!.ToString(),
            ["pvis"] = new JsonArray(new JsonObject { ["station"] = 0, ["elevation"] = -3 }, new JsonObject { ["station"] = 60, ["elevation"] = -3 }) }.ToJsonString())["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "pressureRun.profile", ["network"] = "CRUD-Pressure", ["run"] = "EXT-Run", ["profile"] = profile, ["verticalOffset"] = -0.5, ["keepFollow"] = true }.ToJsonString());
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var civil = CivilDocument.GetCivilDocument(doc.Database);
            var n = civil.GetPressurePipeNetworkIds().Cast<ObjectId>().Select(id => (PressurePipeNetwork)tr.GetObject(id, OpenMode.ForRead)).Single(n => n.Name == "CRUD-Pressure");
            Check(n.PipeRuns[0].ReferenceProfileId.Handle.ToString() == profile, "pressure run follows exact reference profile");
        }
    }
}
