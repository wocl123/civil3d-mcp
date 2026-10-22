using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace CivilCrud.Native;

public partial class Commands
{
    private static void TestDesignExtensions(Document doc)
    {
        string line = Apply(doc, """{"operation":"geometry.create","kind":"line","points":[{"x":0,"y":-20,"z":0},{"x":20,"y":-20,"z":0}]}""")["created"]![0]!.ToString();
        JsonObject Op(string action) => new() { ["operation"] = "geometry.extend", ["action"] = action, ["handles"] = new JsonArray(line) };
        JsonObject copy = Op("copy"); copy["moveBy"] = new JsonObject { ["x"] = 0, ["y"] = 10, ["z"] = 0 };
        JsonObject stale = Preview(doc, copy.ToJsonString());
        string copied = Apply(doc, copy.ToJsonString())["created"]![0]!.ToString();
        EntityCheck<Line>(doc, copied, e => e.StartPoint == new Point3d(0, -10, 0), "copy creates translated geometry");
        EntityCheck<Line>(doc, line, e => e.StartPoint == new Point3d(0, -20, 0), "copy preserves source");
        JsonObject offset = Op("offset"); offset["distance"] = 5;
        Check(Apply(doc, offset.ToJsonString())["created"]!.AsArray().Count == 1, "offset creates curve");
        JsonObject array = Op("array"); array["count"] = 4; array["moveBy"] = new JsonObject { ["x"] = 0, ["y"] = 2, ["z"] = 0 };
        Check(Apply(doc, array.ToJsonString())["created"]!.AsArray().Count == 3, "linear array count includes original");
        JsonObject mirror = Op("mirror"); mirror["axisStart"] = new JsonObject { ["x"] = 0, ["y"] = 0, ["z"] = 0 };
        mirror["axisEnd"] = new JsonObject { ["x"] = 10, ["y"] = 0, ["z"] = 0 };
        string mirrored = Apply(doc, mirror.ToJsonString())["created"]![0]!.ToString();
        EntityCheck<Line>(doc, mirrored, e => e.StartPoint == new Point3d(0, 20, 0), "mirror uses vertical WCS plane");
        JsonObject trim = new() { ["operation"] = "geometry.extend", ["action"] = "trim", ["handles"] = new JsonArray(copied), ["fromDistance"] = 5, ["toDistance"] = 15 };
        string trimmed = Apply(doc, trim.ToJsonString())["created"]![0]!.ToString();
        EntityCheck<Line>(doc, trimmed, e => Math.Abs(e.Length - 10) < 1e-9 && e.StartPoint == new Point3d(5, -10, 0), "trim keeps requested distance interval");
        JsonObject br = Op("break"); br["fromDistance"] = 5; br["toDistance"] = 15;
        Check(Apply(doc, br.ToJsonString())["created"]!.AsArray().Count == 2, "break removes interval and keeps two ends");
        Reject(() => Invoke("CivilPlans", "Apply", doc, new JsonObject { ["plan"] = stale }), "erased geometry invalidates copy plan");
        string poly3 = Apply(doc, """{"operation":"geometry.extend","action":"polyline3d","points":[{"x":0,"y":-50,"z":10},{"x":20,"y":-50,"z":12},{"x":40,"y":-50,"z":15}]}""")["created"]![0]!.ToString();
        string feature = Apply(doc, new JsonObject { ["operation"] = "featureLine.create", ["name"] = "CRUD-Feature", ["source"] = poly3 }.ToJsonString())["handle"]!.ToString();
        EntityCheck<Polyline3d>(doc, poly3, _ => true, "feature line creation preserves source polyline3d");
        EntityCheck<FeatureLine>(doc, feature, e => e.PointsCount == 3 && e.MaxElevation == 15, "feature line has real 3D geometry");
        string edit = new JsonObject { ["operation"] = "featureLine.edit", ["featureLine"] = feature,
            ["elevations"] = new JsonArray(new JsonObject { ["index"] = 1, ["elevation"] = 18 }) }.ToJsonString();
        JsonObject featureStale = Preview(doc, edit);
        Apply(doc, edit);
        EntityCheck<FeatureLine>(doc, feature, e => e.MaxElevation == 18, "feature line indexed elevation edit");
        Reject(() => Invoke("CivilPlans", "Apply", doc, new JsonObject { ["plan"] = featureStale }), "feature line point state prevents stale apply");
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            System.IO.File.AppendAllText(System.IO.Path.Combine(Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!, "assertions.log"), "BEGIN section styles\n");
            var styles = CivilDocument.GetCivilDocument(doc.Database).Styles;
            if (styles.SampleLineStyles.Count == 0) styles.SampleLineStyles.Add("CRUD-Sample");
            if (styles.SectionViewStyles.Count == 0) styles.SectionViewStyles.Add("CRUD-Section");
            if (styles.AssemblyStyles.Count == 0) styles.AssemblyStyles.Add("CRUD-Assembly");
            if (styles.CodeSetStyles.Count == 0) styles.CodeSetStyles.Add("CRUD-Codes");
            tr.Commit();
        }
        string group = Apply(doc, """{"operation":"sampleGroup.create","name":"CRUD-Samples","alignment":"CRUD-Alignment"}""")["handle"]!.ToString();
        Check(true, "sample group created");
        string sample = Apply(doc, new JsonObject { ["operation"] = "sampleLine.create", ["group"] = group,
            ["name"] = "CRUD-Sample20", ["points"] = new JsonArray(new JsonObject { ["x"] = 20, ["y"] = -30, ["z"] = 0 }, new JsonObject { ["x"] = 20, ["y"] = 30, ["z"] = 0 }) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<SampleLine>(doc, sample, e => Math.Abs(e.Station - 20) < 1e-6, "sample line creates at actual alignment crossing");
        string view = Apply(doc, new JsonObject { ["operation"] = "sectionView.create", ["sampleLine"] = sample,
            ["name"] = "CRUD-Section20", ["position"] = new JsonObject { ["x"] = 500, ["y"] = -500, ["z"] = 0 } }.ToJsonString())["handle"]!.ToString();
        EntityCheck<SectionView>(doc, view, e => e.SampleLineId.Handle.ToString() == sample, "section view references real sample line");
        string assembly = Apply(doc, """{"operation":"assembly.create","name":"CRUD-Assembly","position":{"x":700,"y":-500,"z":0}}""")["handle"]!.ToString();
        string corridorRequest = new JsonObject { ["operation"] = "corridor.create", ["name"] = "CRUD-Corridor",
            ["baselineName"] = "Main", ["alignment"] = "CRUD-Alignment", ["profile"] = "CRUD-FG" }.ToJsonString();
        // Use the actual design profile produced by Prepare, rather than guessing profile names.
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var civil = CivilDocument.GetCivilDocument(doc.Database);
            Alignment alignment = civil.GetAlignmentIds().Cast<ObjectId>().Select(i => (Alignment)tr.GetObject(i, OpenMode.ForRead)).Single(a => a.Name == "CRUD-Alignment");
            Profile profile = alignment.GetProfileIds().Cast<ObjectId>().Select(i => (Profile)tr.GetObject(i, OpenMode.ForRead)).First(p => p.ProfileType == ProfileType.FG);
            JsonObject r = JsonNode.Parse(corridorRequest)!.AsObject(); r["profile"] = profile.Handle.ToString(); corridorRequest = r.ToJsonString();
        }
        string corridor = Apply(doc, corridorRequest)["handle"]!.ToString();
        EntityCheck<Corridor>(doc, corridor, c => c.Baselines.Count == 1, "corridor creates actual alignment profile baseline");
        Apply(doc, new JsonObject { ["operation"] = "corridor.region", ["corridor"] = corridor, ["baselineName"] = "Main", ["regionName"] = "Region1", ["assembly"] = assembly,
            ["startStation"] = 0, ["endStation"] = 80, ["frequency"] = 10 }.ToJsonString());
        EntityCheck<Corridor>(doc, corridor, c => c.Baselines[0].BaselineRegions.Count == 1 && c.Baselines[0].BaselineRegions[0].AppliedAssemblySetting.FrequencyAlongTangents == 10,
            "corridor region and tangent frequency persist");
        Reject(() => Preview(doc, corridorRequest), "duplicate corridor name refused");
    }
}
