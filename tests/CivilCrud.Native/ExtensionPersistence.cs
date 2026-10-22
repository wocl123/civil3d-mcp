using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Runtime;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using App = Autodesk.AutoCAD.ApplicationServices.Application;

namespace CivilCrud.Native;

public partial class Commands
{
    [CommandMethod("MYC3DEXTENSIONREOPENTEST")]
    public void ReopenExtensions()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        _plugin = System.Reflection.Assembly.LoadFrom(Path.Combine(folder, "MyCivil3DMcp.Plugin.dll"));
        var old = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "result.json")))!;
        Passed.AddRange(old["passed"]!.AsArray().Select(n => n!.ToString()));
        string? failure = null;
        Document doc = App.DocumentManager.MdiActiveDocument;
        try
        {
            var feature = ReadResult("FeatureLineChanges", "List", doc, 0, 50)["items"]!.AsArray().Single(n => n!["name"]!.ToString() == "CRUD-Feature")!;
            Check(feature["maxElevation"]!.GetValue<double>() == 18, "reopened feature-line elevation persists");
            var groups = ReadResult("SectionChanges", "List", doc, new JsonObject { ["kind"] = "sampleGroups" });
            Check(groups["items"]!.AsArray().Any(n => n!["name"]!.ToString() == "CRUD-Samples"), "reopened sample group persists");
            var corridors = ReadResult("CorridorChanges", "List", doc, new JsonObject { ["kind"] = "corridors" });
            Check(corridors["items"]!.AsArray().Any(n => n!["name"]!.ToString() == "CRUD-Corridor"), "reopened corridor baseline and region persist");
            using Transaction tr = doc.Database.TransactionManager.StartTransaction();
            var civil = CivilDocument.GetCivilDocument(doc.Database);
            var point = (CogoPoint)tr.GetObject(civil.CogoPoints.GetPointByPointNumber(89001), OpenMode.ForRead);
            var udp = (UDPString)civil.PointUDPClassifications["EXT-UDP"].UDPs.Single(u => u.Name == "Note");
            Check(point.GetUDPValue(udp) == "측량 속성", "reopened COGO UDP value persists");
            var network = civil.GetPressurePipeNetworkIds().Cast<ObjectId>().Select(i => (PressurePipeNetwork)tr.GetObject(i, OpenMode.ForRead)).Single(n => n.Name == "CRUD-Pressure");
            var pipe = network.GetPipeIds().Cast<ObjectId>().Select(i => (PressurePipe)tr.GetObject(i, OpenMode.ForRead)).Single(p => p.Name == "CRUD-PressurePipe");
            Check(Math.Abs(pipe.EndPoint.Z + 3) < 1e-8 && pipe.EndPoint.X == 1430, "reopened pressure pipe geometry persists");
            Check(network.GetPipeIds().Cast<ObjectId>().Select(i => (PressurePipe)tr.GetObject(i, OpenMode.ForRead)).Any(p => p.IsCurve), "reopened curved pressure pipe persists");
            Check(network.PipeRuns.Count == 1 && network.PipeRuns[0].GetPartIds().Count > 0, "reopened pressure run retains actual parts");
            var sample = civil.GetAlignmentIds().Cast<ObjectId>().Select(i => (Alignment)tr.GetObject(i, OpenMode.ForRead)).Single(a => a.Name == "CRUD-Alignment")
                .GetSampleLineGroupIds().Cast<ObjectId>().Select(i => (SampleLineGroup)tr.GetObject(i, OpenMode.ForRead))
                .SelectMany(g => g.GetSampleLineIds().Cast<ObjectId>()).Select(i => (SampleLine)tr.GetObject(i, OpenMode.ForRead)).Single(l => l.Name == "CRUD-Sample20");
            Check(sample.Station == 25, "reopened edited sample station persists");
            var catchment = CatchmentGroupCollection.GetCatchmentGroups(doc.Database).Cast<ObjectId>().Select(i => (CatchmentGroup)tr.GetObject(i, OpenMode.ForRead))
                .SelectMany(g => g.GetAllCatchmentIds().Cast<ObjectId>()).Select(i => (Catchment)tr.GetObject(i, OpenMode.ForRead)).Single(c => c.Name == "EXT-Catchment");
            Check(Math.Abs(catchment.RunoffCoefficient - 0.6) < 1e-9 && catchment.CurveNumber == 75, "reopened catchment hydrology properties persist");
            var sub = civil.SubassemblyCollection.Cast<ObjectId>().Select(i => (Subassembly)tr.GetObject(i, OpenMode.ForRead)).Single(s => s.Name == "EXT-WidthSlope");
            Check(sub.ParamsDouble.Any(p => p.Key.Equals("Width", StringComparison.OrdinalIgnoreCase) && p.Value == 7), "reopened stock subassembly width persists");
            var workflowRoad = civil.GetAlignmentIds().Cast<ObjectId>().Select(id => (Alignment)tr.GetObject(id, OpenMode.ForRead)).Single(a => a.Name == "T3-Road");
            Check(workflowRoad.GetProfileIds().Count > 0 && civil.CorridorCollection.Cast<ObjectId>().Select(id => (Corridor)tr.GetObject(id, OpenMode.ForRead)).Any(c => c.Name == "T3-Corridor" && c.CorridorSurfaces.Count > 0), "reopened dependent workflow retains profile corridor and surface");
            var terrain = civil.GetSurfaceIds().Cast<ObjectId>().Select(id => tr.GetObject(id, OpenMode.ForRead)).OfType<TinSurface>().Single(s => s.Name == "EXT-Surface");
            using (var analysis = terrain.Analysis) Check(analysis.GetElevationData().Length == 2 && analysis.GetSlopeData().Length == 1, "reopened elevation and slope analysis bands persist");
            var superRoad = civil.GetAlignmentIds().Cast<ObjectId>().Select(id => (Alignment)tr.GetObject(id, OpenMode.ForRead)).Single(a => a.Name == "T4-SuperRoad");
            Check(superRoad.SuperelevationCurves.Any(c => c.CriticalStations.Any(s => Math.Abs(s.Station - 50) < 1e-8 && Math.Abs(s.GetSlope(Autodesk.Civil.SuperelevationCrossSegmentType.LeftOutLaneCrossSlope) + 0.06) < 1e-8)), "reopened explicit superelevation slope persists");
            Check(ReadResult("PropertySetChanges", "List", doc, new JsonObject())["items"]!.AsArray().Single(d => d!["name"]!.ToString() == "T4-Properties")!["properties"]!.AsArray().Count == 4, "reopened property-set schema expansion persists");
        }
        catch (System.Exception error) { failure = error.ToString(); }
        File.WriteAllText(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(new { passed = Passed, failure }, Json));
    }
}
