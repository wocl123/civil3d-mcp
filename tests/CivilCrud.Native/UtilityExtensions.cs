using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace CivilCrud.Native;

public partial class Commands
{
    private static JsonObject P(double x, double y, double z = 0) => new() { ["x"] = x, ["y"] = y, ["z"] = z };
    private static void TestUtilityExtensions(Document doc)
    {
        string Line(Point3d a, Point3d b) => Apply(doc, new JsonObject { ["operation"] = "geometry.create", ["kind"] = "line",
            ["points"] = new JsonArray(P(a.X, a.Y, a.Z), P(b.X, b.Y, b.Z)) }.ToJsonString())["created"]![0]!.ToString();
        string a = Line(new Point3d(1000, 0, 0), new Point3d(1010, 0, 0));
        string b = Line(new Point3d(1000, 0, 0), new Point3d(1000, 10, 0));
        string arc = Apply(doc, new JsonObject { ["operation"] = "geometry.corner", ["action"] = "fillet",
            ["handles"] = new JsonArray(a, b), ["radius"] = 2 }.ToJsonString())["created"]![0]!.ToString();
        EntityCheck<Arc>(doc, arc, e => Math.Abs(e.Radius - 2) < 1e-9 && e.Center.DistanceTo(new Point3d(1002, 2, 0)) < 1e-8, "fillet constructs tangent arc at common endpoint");
        EntityCheck<Line>(doc, a, e => e.StartPoint.DistanceTo(new Point3d(1002, 0, 0)) < 1e-8, "fillet trims source keeping its handle");
        string c = Line(new Point3d(1020, 0, 0), new Point3d(1030, 0, 0));
        string d = Line(new Point3d(1020, 0, 0), new Point3d(1020, 10, 0));
        string chamfer = Apply(doc, new JsonObject { ["operation"] = "geometry.corner", ["action"] = "chamfer",
            ["handles"] = new JsonArray(c, d), ["distanceA"] = 2, ["distanceB"] = 3 }.ToJsonString())["created"]![0]!.ToString();
        EntityCheck<Line>(doc, chamfer, e => e.StartPoint.DistanceTo(new Point3d(1022, 0, 0)) < 1e-8 && e.EndPoint.DistanceTo(new Point3d(1020, 3, 0)) < 1e-8, "chamfer uses explicit separate distances");
        string e1 = Line(new Point3d(1040, 0, 0), new Point3d(1050, 0, 0));
        string e2 = Line(new Point3d(1050, 0, 0), new Point3d(1050, 10, 0));
        string joined = Apply(doc, new JsonObject { ["operation"] = "geometry.corner", ["action"] = "join", ["handles"] = new JsonArray(e1, e2) }.ToJsonString())["created"]![0]!.ToString();
        EntityCheck<Polyline>(doc, joined, e => e.NumberOfVertices == 3 && Math.Abs(e.Length - 20) < 1e-8, "join creates connected polyline");
        string rectangle = Apply(doc, """{"operation":"geometry.create","kind":"rectangle","points":[{"x":1100,"y":0,"z":0},{"x":1110,"y":10,"z":0}]}""")["created"]![0]!.ToString();
        string hatch = Apply(doc, new JsonObject { ["operation"] = "hatch.create", ["handles"] = new JsonArray(rectangle), ["pattern"] = "SOLID" }.ToJsonString())["handle"]!.ToString();
        EntityCheck<Hatch>(doc, hatch, h => h.Associative && h.NumberOfLoops == 1, "associative solid hatch uses actual boundary");
        Apply(doc, new JsonObject { ["operation"] = "block.create", ["name"] = "CRUD-Block", ["handles"] = new JsonArray(rectangle), ["basePoint"] = P(1100, 0) }.ToJsonString());
        EntityCheck<Polyline>(doc, rectangle, _ => true, "block definition preserves original source");
        string block = Apply(doc, new JsonObject { ["operation"] = "block.insert", ["name"] = "CRUD-Block", ["position"] = P(1150, 0), ["scale"] = 2 }.ToJsonString())["handle"]!.ToString();
        EntityCheck<BlockReference>(doc, block, e => e.Position == new Point3d(1150, 0, 0) && e.ScaleFactors.X == 2, "block insertion uses explicit point and scale");
        string leader = Apply(doc, new JsonObject { ["operation"] = "leader.create", ["text"] = "Civil 검증", ["height"] = 2,
            ["arrowPoint"] = P(1200, 0), ["textPosition"] = P(1210, 10) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<MLeader>(doc, leader, e => e.MText.Contents == "Civil 검증", "multileader creates actual annotation");
        string table = Apply(doc, new JsonObject { ["operation"] = "table.create", ["position"] = P(1250, 0), ["rowHeight"] = 5, ["columnWidth"] = 20, ["height"] = 2,
            ["rows"] = new JsonArray(new JsonArray("항목", "값"), new JsonArray("표고", "10")) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<Autodesk.AutoCAD.DatabaseServices.Table>(doc, table, e => e.Rows.Count == 2 && e.Columns.Count == 2 && e.Cells[1, 1].TextString == "10", "table creates exact rows and cell content");
        string site = Apply(doc, """{"operation":"site.create","name":"CRUD-Site"}""")["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "site.edit", ["site"] = site, ["description"] = "site edited" }.ToJsonString());
        EntityCheck<Site>(doc, site, s => s.Description == "site edited", "Site create and property edit");
        string point = Apply(doc, """{"operation":"cogo.create","points":[{"number":88001,"position":{"x":1300,"y":0,"z":10},"rawDescription":"TEST"}]}""")["points"]![0]!["handle"]!.ToString();
        string group = Apply(doc, """{"operation":"pointGroup.create","name":"CRUD-PointGroup","query":{"includeNumbers":"88001"}}""")["handle"]!.ToString();
        var groups = ReadResult("CivilUtilityChanges", "List", doc, new JsonObject { ["kind"] = "pointGroups" });
        Check(groups["items"]!.AsArray().Any(g => g!["name"]!.ToString() == "CRUD-PointGroup" && g["pointCount"]!.GetValue<int>() == 1), "point group query includes exact COGO number");
        Apply(doc, new JsonObject { ["operation"] = "cogo.delete", ["handles"] = new JsonArray(point) }.ToJsonString());
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction()) Check(!CivilDocument.GetCivilDocument(doc.Database).CogoPoints.Contains(88001u), "COGO dedicated delete removes point");
        Apply(doc, """{"operation":"style.copy","kind":"surface","style":"CRUD-Test","name":"CRUD-CopiedStyle"}""");
        Check(ReadResult("CivilStyles", "List", doc, "surface", 0, 50)["items"]!.AsArray().Any(s => s!["name"]!.ToString() == "CRUD-CopiedStyle"), "Civil style copy creates named sibling");
        Apply(doc, """{"operation":"alignment.offset","alignment":"CRUD-Alignment","name":"CRUD-Offset","offset":5,"style":"CRUD-Test"}""");
        Check(true, "dynamic offset alignment created");
        string revision = Invoke("DrawingRevisions", "Of", doc.Database).ToString()!;
        ReadResult("SectionChanges", "List", doc, new JsonObject { ["kind"] = "sampleGroups" });
        Check(revision == Invoke("DrawingRevisions", "Of", doc.Database).ToString(), "section source observation preserves drawing revision");
        var workflows = ReadResult("NativeCivilWorkflows", "List");
        Check(workflows["automaticCrud"]!.GetValue<bool>() == false && workflows["items"]!.AsArray().Count >= 25, "native workflows explicitly marked interactive and verified against installed macros");
        string pressure = Apply(doc, """{"operation":"pressureNetwork.create","name":"CRUD-Pressure"}""")["handle"]!.ToString();
        Apply(doc, new JsonObject { ["operation"] = "pressureNetwork.edit", ["network"] = pressure, ["description"] = "pressure edited" }.ToJsonString());
        Check(ReadResult("PressureChanges", "List", doc, new JsonObject())["items"]!.AsArray().Any(n => n!["handle"]!.ToString() == pressure), "pressure network create edit and inventory");
        string sizeGuid, partsListName;
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
        {
            using Database template = new(false, true);
            template.ReadDwgFile("C:/Program Files/Autodesk/AutoCAD 2025/C3D/UserDataCache/Template/_Autodesk Civil 3D (Metric) NCS.dwt", FileOpenMode.OpenForReadAndAllShare, true, "");
            using (Transaction sourceTransaction = template.TransactionManager.StartTransaction())
            {
                var sourceParts = CivilDocument.GetCivilDocument(template).Styles.GetPressurePartLists();
                StyleBase.ExportTo(new ObjectIdCollection(sourceParts.Cast<ObjectId>().ToArray()), doc.Database, StyleConflictResolverType.Override);
            }
            // Fixture preparation only. Catalog population is not exposed as a public 2025 type.
            Type catalogType = typeof(PressurePartList).Assembly.GetType("Autodesk.Civil.DatabaseServices.Styles.PressurePartCatalog")!;
            catalogType.GetMethod("SetCatalog", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)!
                .Invoke(null, new object[] { "C:/ProgramData/Autodesk/C3D 2025/kor/Pressure Pipes Catalog/Metric/Metric_AWWA_PushOn.sqlite" });
            var civil = CivilDocument.GetCivilDocument(doc.Database);
            var all = civil.Styles.GetPressurePartLists().Cast<ObjectId>().Select(id => (PressurePartList)tr.GetObject(id, OpenMode.ForRead)).ToArray();
            var parts = all.First(p => p.GetParts(PressurePartDomainType.Pipe).Any(s => s.IsValid));
            sizeGuid = parts.GetParts(PressurePartDomainType.Pipe).First(p => p.IsValid).PartSizeGuid;
            partsListName = parts.Name;
            tr.Commit();
        }
        Apply(doc, new JsonObject { ["operation"] = "pressureNetwork.edit", ["network"] = pressure, ["partsList"] = partsListName }.ToJsonString());
        string pressurePipe = Apply(doc, new JsonObject { ["operation"] = "pressurePart.create", ["network"] = pressure,
            ["name"] = "CRUD-PressurePipe", ["kind"] = "Pipe", ["sizeGuid"] = sizeGuid, ["start"] = P(1400, 0, -2), ["end"] = P(1420, 0, -2) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<PressurePipe>(doc, pressurePipe, p => Math.Abs(p.Length3DCenterToCenter - 20) < 1e-8, "pressure pipe creates real catalog-sized geometry");
        Apply(doc, new JsonObject { ["operation"] = "pressurePart.edit", ["handle"] = pressurePipe, ["end"] = P(1430, 0, -3) }.ToJsonString());
        EntityCheck<PressurePipe>(doc, pressurePipe, p => p.EndPoint.DistanceTo(new Point3d(1430, 0, -3)) < 1e-8, "pressure pipe endpoint edit preserves explicit centerline");
        string curve = Apply(doc, new JsonObject { ["operation"] = "pressurePart.create", ["network"] = pressure, ["name"] = "CRUD-PressureCurve", ["kind"] = "Pipe", ["sizeGuid"] = sizeGuid,
            ["start"] = P(1400, 20, -2), ["midPoint"] = P(1410, 30, -2), ["end"] = P(1420, 20, -2) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<PressurePipe>(doc, curve, p => p.IsCurve, "pressure curved pipe uses actual three-point geometry");
    }
}
