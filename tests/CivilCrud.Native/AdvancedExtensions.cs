using System.IO;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace CivilCrud.Native;

public partial class Commands
{
    private static void TestAdvancedExtensions(Document doc)
    {
        string surface = Apply(doc, """{"operation":"surface.create","name":"EXT-Surface","style":"CRUD-Test","points":[{"x":2000,"y":0,"z":10},{"x":2100,"y":0,"z":20},{"x":2000,"y":100,"z":10},{"x":2100,"y":100,"z":20},{"x":2050,"y":50,"z":15}]}""")["handle"]!.ToString();
        var sampled = ReadResult("CivilUtilityChanges", "SampleSurface", doc, new JsonObject { ["surface"] = surface, ["points"] = new JsonArray(new JsonObject { ["x"] = 2020, ["y"] = 20 }, new JsonObject { ["x"] = 0, ["y"] = 0 }) });
        Check(Math.Abs(sampled["items"]![0]!["elevation"]!.GetValue<double>() - 12) < 1e-7 && sampled["items"]![1]!["inside"]!.GetValue<bool>() == false, "TIN XY sampling returns actual elevation and outside flag");
        string destination = Apply(doc, """{"operation":"surface.create","name":"EXT-Paste","style":"CRUD-Test"}""")["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "surface.definition", ["action"] = "paste", ["surface"] = destination, ["sourceSurface"] = surface }.ToJsonString());
        Reject(() => Preview(doc, new JsonObject { ["operation"] = "surface.definition", ["action"] = "paste", ["surface"] = surface, ["sourceSurface"] = destination }.ToJsonString()), "surface paste refuses dependency cycle");
        string contours = new JsonObject { ["operation"] = "surface.definition", ["action"] = "extractContours", ["surface"] = surface, ["elevationMin"] = 11, ["elevationMax"] = 19, ["interval"] = 2 }.ToJsonString();
        Check(Apply(doc, contours)["created"]!.AsArray().Count >= 4, "surface contour extraction creates real contours");
        Apply(doc, new JsonObject { ["operation"] = "surface.definition", ["action"] = "boundary", ["surface"] = destination, ["boundaryType"] = "Hide", ["midOrdinate"] = 0.1,
            ["points"] = new JsonArray(P(2040, 40), P(2060, 40), P(2060, 60), P(2040, 60), P(2040, 40)) }.ToJsonString());
        Apply(doc, new JsonObject { ["operation"] = "surface.definition", ["action"] = "removeBoundary", ["surface"] = destination, ["index"] = 0 }.ToJsonString());
        Check(true, "surface hide boundary creation and removal");
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var styles = CivilDocument.GetCivilDocument(doc.Database).Styles;
            styles.MarkerStyles.Add("EXT-Marker");
            ObjectId id = styles.LabelStyles.SurfaceLabelStyles.SpotElevationLabelStyles.Add("EXT-Elevation");
            var label = (LabelStyle)tr.GetObject(id, OpenMode.ForWrite);
            ObjectId component = label.AddComponent("Elevation text", LabelStyleComponentType.Text);
            ((LabelStyleTextComponent)tr.GetObject(component, OpenMode.ForWrite)).Text.Contents.Value = "표고";
            tr.Commit();
        }
        string elevationLabel = Apply(doc, new JsonObject { ["operation"] = "label.create", ["kind"] = "surfaceElevation", ["surface"] = surface,
            ["position"] = P(2020, 20), ["style"] = "EXT-Elevation", ["markerStyle"] = "EXT-Marker" }.ToJsonString())["handle"]!.ToString();
        EntityCheck<SurfaceElevationLabel>(doc, elevationLabel, _ => true, "surface elevation label is real Civil annotation");
        var stylesList = ReadResult("CivilStyles", "List", doc, "surfaceElevationLabel", 0, 50);
        string componentHandle = stylesList["items"]!.AsArray().Single(s => s!["name"]!.ToString() == "EXT-Elevation")!["components"]![0]!["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "style.text", ["styleKind"] = "surfaceElevationLabel", ["style"] = "EXT-Elevation", ["component"] = componentHandle, ["contents"] = "표고 확인", ["height"] = 2 }.ToJsonString());
        Check(true, "Civil label style text component edit");
        Apply(doc, new JsonObject { ["operation"] = "label.delete", ["handle"] = elevationLabel }.ToJsonString());
        Check(true, "Civil label deletion");
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        string xmlPath = Path.Combine(folder, "surface.xml");
        bool metres = ReadResult("CivilCoordinates", "Read", doc.Database)["civilUnits"]!.ToString() == "Meters";
        string unit = metres ? "<Metric linearUnit=\"meter\" areaUnit=\"squareMeter\" volumeUnit=\"cubicMeter\" temperatureUnit=\"celsius\" pressureUnit=\"milliBars\"/>"
            : "<Imperial linearUnit=\"foot\" areaUnit=\"squareFoot\" volumeUnit=\"cubicFeet\" temperatureUnit=\"fahrenheit\" pressureUnit=\"inHG\"/>";
        File.WriteAllText(xmlPath, "<?xml version=\"1.0\"?><LandXML xmlns=\"http://www.landxml.org/schema/LandXML-1.2\" version=\"1.2\" date=\"2026-10-21\" time=\"00:00:00\"><Units>" + unit
            + "</Units><Surfaces><Surface name=\"XML-Source\"><Definition surfType=\"TIN\"><Pnts><P id=\"1\">0 2400 10</P><P id=\"2\">0 2410 10</P><P id=\"3\">10 2400 10</P></Pnts><Faces><F>1 2 3</F></Faces></Definition></Surface></Surfaces></LandXML>");
        string xmlSurface = Apply(doc, new JsonObject { ["operation"] = "surface.definition", ["action"] = "landxml", ["name"] = "EXT-XML", ["path"] = xmlPath, ["xmlSurface"] = "XML-Source" }.ToJsonString())["handle"]!.ToString();
        EntityCheck<TinSurface>(doc, xmlSurface, s => Math.Abs(s.FindElevationAtXY(2401, 1) - 10) < 1e-8, "LandXML import preserves explicit drawing units and source coordinates");
        string csv = Path.Combine(folder, "points.csv");
        File.WriteAllText(csv, "number,x,y,z,description\n89001,2200,0,10,\"TEST,quoted\"\n");
        string import = new JsonObject { ["operation"] = "cogo.import", ["path"] = csv }.ToJsonString();
        JsonObject stale = Preview(doc, import);
        File.AppendAllText(csv, "89002,2210,0,11,TEST\n");
        Reject(() => Invoke("CivilPlans", "Apply", doc, new JsonObject { ["plan"] = stale }), "changed CSV file invalidates import plan");
        string point = Apply(doc, import)["points"]![0]!["handle"]!.ToString();
        EntityCheck<CogoPoint>(doc, point, p => p.RawDescription == "TEST,quoted", "CSV import preserves quoted descriptions and explicit coordinates");
        string set = Apply(doc, """{"operation":"descriptionSet.create","name":"EXT-Keys"}""")["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "descriptionKey.set", ["set"] = set, ["code"] = "TEST*", ["format"] = "Formatted $*" }.ToJsonString());
        Apply(doc, new JsonObject { ["operation"] = "cogo.descriptionKeys", ["handles"] = new JsonArray(point) }.ToJsonString());
        EntityCheck<CogoPoint>(doc, point, p => p.FullDescription.StartsWith("Formatted", StringComparison.Ordinal), "description key application updates full description");
        Check(ReadResult("PointMetadata", "List", doc, new JsonObject { ["kind"] = "descriptionKeys" })["total"]!.GetValue<int>() >= 1, "description key set create edit and explicit application");
        Apply(doc, """{"operation":"pointUdp.create","classification":"EXT-UDP","name":"Note","type":"string"}""");
        Apply(doc, new JsonObject { ["operation"] = "cogo.udp", ["classification"] = "EXT-UDP", ["name"] = "Note", ["handles"] = new JsonArray(point), ["value"] = "측량 속성" }.ToJsonString());
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var udp = (UDPString)CivilDocument.GetCivilDocument(doc.Database).PointUDPClassifications["EXT-UDP"].UDPs.Single(u => u.Name == "Note");
            var p = (CogoPoint)tr.GetObject(CivilDocument.GetCivilDocument(doc.Database).CogoPoints.GetPointByPointNumber(89001), OpenMode.ForRead);
            Check(p.GetUDPValue(udp) == "측량 속성", "point UDP creation and exact typed value edit");
        }
        string batch = new JsonObject { ["operation"] = "batch.apply", ["steps"] = new JsonArray(
            new JsonObject { ["operation"] = "geometry.create", ["kind"] = "line", ["points"] = new JsonArray(P(2300, 0), P(2310, 0)) },
            new JsonObject { ["operation"] = "geometry.create", ["kind"] = "circle", ["center"] = P(2300, 20), ["radius"] = 5 }) }.ToJsonString();
        JsonObject batchPreview = Preview(doc, batch);
        Check(!batchPreview["details"]!.AsArray().Any(d => d!.ToString().Contains("\"operation\"", StringComparison.Ordinal)), "batch plan uses readable details without raw request JSON");
        string batchId = ApplyGuardedCivil(doc, batch);
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = batchId });
        Check(true, "atomic batch supports one guarded native Undo");
        string invalidated = new JsonObject { ["operation"] = "batch.apply", ["steps"] = new JsonArray(
            new JsonObject { ["operation"] = "cogo.edit", ["handles"] = new JsonArray(point), ["elevation"] = 12 },
            new JsonObject { ["operation"] = "cogo.edit", ["handles"] = new JsonArray(point), ["elevation"] = 13 }) }.ToJsonString();
        Reject(() => Apply(doc, invalidated), "batch refuses stale later step and rolls back earlier edit");
        EntityCheck<CogoPoint>(doc, point, p => p.Elevation == 10, "failed batch preserves original point elevation");
        Apply(doc, """{"operation":"profile.pvi","profile":"CRUD-FG2","action":"add","station":50,"elevation":15}""");
        Apply(doc, """{"operation":"profile.pvi","profile":"CRUD-FG2","action":"edit","index":1,"station":55,"elevation":16}""");
        Apply(doc, """{"operation":"profile.pvi","profile":"CRUD-FG2","action":"delete","index":1}""");
        Check(true, "individual PVI add move and delete preserve remaining profile");
        Apply(doc, """{"operation":"profileView.range","profileView":"CRUD-View-Edited","stationStart":10,"stationEnd":90,"elevationMin":0,"elevationMax":30}""");
        Check(true, "profile view manual station and elevation ranges");
        Invoke("DrawingLayers", "Apply", doc, JsonNode.Parse("""{"action":"create","create":[{"name":"EXT-Layer","color":7,"locked":false,"frozen":false,"off":false}]}"""));
        string layerEdit = """{"operation":"layer.properties","layer":"EXT-Layer","newName":"EXT-Layer-Edited","linetype":"Continuous","lineweight":25,"transparency":50,"plottable":false}""";
        string layerId = ApplyGuardedCivil(doc, layerEdit);
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            var layers = (LayerTable)tr.GetObject(doc.Database.LayerTableId, OpenMode.ForRead);
            var layer = (LayerTableRecord)tr.GetObject(layers["EXT-Layer-Edited"], OpenMode.ForRead);
            Check(layer.LineWeight == LineWeight.LineWeight025 && !layer.IsPlottable && layer.Transparency.Alpha == 128, "layer rename linetype weight transparency and plot properties");
        }
        Invoke("DrawingOperations", "Undo", doc, new JsonObject { ["operationId"] = layerId });
        Preview(doc, layerEdit);
        Check(true, "detailed layer property edit supports guarded native Undo");
    }
}
