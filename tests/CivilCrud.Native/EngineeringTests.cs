using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace CivilCrud.Native;

public partial class Commands
{
    private static void TestEngineeringObjects(Document document)
    {
        TestCogoPoints(document);
        TestVolumeSurfaces(document);
    }

    private static void TestCogoPoints(Document document)
    {
        Database database = document.Database;
        CivilDocument civil = CivilDocument.GetCivilDocument(database);
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            civil.Styles.PointStyles.Add("ENG-Point");
            civil.Styles.LabelStyles.PointLabelStyles.LabelStyles.Add("ENG-PointLabel");
            transaction.Commit();
        }

        const string create = """
            {"operation":"cogo.create","points":[{"number":1001,"position":{"x":50,"y":60,"z":70},"rawDescription":"CP-A"},
            {"number":1002,"position":{"x":80,"y":90,"z":100},"rawDescription":"CP-B"}],
            "style":"ENG-Point","labelStyle":"ENG-PointLabel"}
            """;
        Preview(document, create);
        Check(civil.CogoPoints.Count == 0, "COGO preview creates no points");
        JsonArray created = Apply(document, create)["points"]!.AsArray();
        string first = created[0]!["handle"]!.GetValue<string>();
        string second = created[1]!["handle"]!.GetValue<string>();
        Check(civil.CogoPoints.Count == 2 && civil.CogoPoints.Contains(1001) && civil.CogoPoints.Contains(1002),
            "COGO creates exact explicit numbers without replacement");
        EntityCheck<CogoPoint>(document, first, point => point.Location.DistanceTo(new Point3d(50, 60, 70)) < 1e-8
            && point.RawDescription == "CP-A", "COGO creates exact coordinates and raw description");
        Check(ReadResult("CivilStyles", "List", document, "point", 0, 50)["total"]!.GetValue<int>() > 0,
            "Civil point style catalog is readable");
        Reject(() => Preview(document, create), "COGO duplicate existing number refused");
        Reject(() => Preview(document, """
            {"operation":"cogo.create","points":[{"number":1003,"position":{"x":0,"y":0,"z":0}},
            {"number":1003,"position":{"x":1,"y":1,"z":1}}]}
            """), "COGO duplicate batch numbers refused");

        JsonObject edit = new() { ["operation"] = "cogo.edit", ["handles"] = new JsonArray(first, second),
            ["moveBy"] = new JsonObject { ["x"] = 1, ["y"] = 2, ["z"] = 3 }, ["rawDescription"] = "UPDATED" };
        JsonObject stale = Preview(document, edit.ToJsonString());
        Apply(document, edit.ToJsonString());
        EntityCheck<CogoPoint>(document, first, point => point.Location.DistanceTo(new Point3d(51, 62, 73)) < 1e-8
            && point.RawDescription == "UPDATED", "COGO batch translation and description edit");
        Reject(() => Invoke("CivilPlans", "Apply", document, new JsonObject { ["plan"] = stale }),
            "changed COGO source invalidates previous plan");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "cogo.edit", ["handles"] = new JsonArray(first),
            ["number"] = 1002 }.ToJsonString()), "COGO renumber cannot overwrite another point");
        Apply(document, new JsonObject { ["operation"] = "cogo.edit", ["handles"] = new JsonArray(first),
            ["number"] = 1101, ["elevation"] = 80 }.ToJsonString());
        Check(!civil.CogoPoints.Contains(1001) && civil.CogoPoints.Contains(1101), "COGO explicit renumber");
        EntityCheck<CogoPoint>(document, first, point => point.Elevation == 80 && point.Easting == 51,
            "COGO elevation-only edit preserves XY");
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            ((CogoPoint)transaction.GetObject(civil.CogoPoints.GetPointByPointNumber(1002), OpenMode.ForWrite)).IsLocked = true;
            transaction.Commit();
        }

        Reject(() => Preview(document, edit.ToJsonString()), "one locked COGO point blocks entire batch");
        EntityCheck<CogoPoint>(document, first, point => point.Elevation == 80, "blocked COGO batch preserves other point");
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            ((CogoPoint)transaction.GetObject(civil.CogoPoints.GetPointByPointNumber(1002), OpenMode.ForWrite)).IsLocked = false;
            transaction.Commit();
        }

        string operationId = ApplyGuardedCivil(document, new JsonObject { ["operation"] = "cogo.edit",
            ["handles"] = new JsonArray(first), ["elevation"] = 90 }.ToJsonString());
        Invoke("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = operationId });
        EntityCheck<CogoPoint>(document, first, point => point.Elevation == 80, "COGO native edit Undo");
        string newRequest = """
            {"operation":"cogo.create","points":[{"number":1200,"position":{"x":1,"y":2,"z":3}}]}
            """;
        JsonObject plan = Preview(document, newRequest);
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            Invoke("CogoChanges", "Apply", database, transaction, plan["request"]!.AsObject());
        }

        Check(!civil.CogoPoints.Contains(1200), "COGO creation rolls back without commit");
        operationId = ApplyGuardedCivil(document, newRequest);
        Invoke("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = operationId });
        Check(!civil.CogoPoints.Contains(1200), "COGO native creation Undo restores point collection");
    }

    private static void TestVolumeSurfaces(Document document)
    {
        foreach (var (name, z, x) in new[] { ("ENG-Base", 10, 0), ("ENG-Comparison", 12, 0), ("ENG-Disjoint", 15, 1000) })
        {
            Apply(document, new JsonObject { ["operation"] = "surface.create", ["name"] = name,
                ["points"] = new JsonArray(Xyz(x, 0, z), Xyz(x + 100, 0, z), Xyz(x, 100, z)) }.ToJsonString());
        }

        const string create = """
            {"operation":"volume.create","name":"ENG-Volume","baseSurface":"ENG-Base",
            "comparisonSurface":"ENG-Comparison","cutFactor":1.2,"fillFactor":1.3}
            """;
        JsonObject preview = Preview(document, create);
        Check(!ReadResult("SurfaceChanges", "List", document, 0, 50)["items"]!.AsArray()
            .Any(node => node!["name"]?.ToString() == "ENG-Volume"), "volume preview leaves no new surface");
        JsonObject result = Apply(document, create);
        string handle = result["handle"]!.GetValue<string>();
        Check(Math.Abs(result["fill"]!.GetValue<double>() - 10000) < 1e-5
            && Math.Abs(result["adjustedFill"]!.GetValue<double>() - 13000) < 1e-5,
            "TIN volume computes known planar fill and factor");
        Reject(() => Preview(document, create), "duplicate volume surface name refused");
        Reject(() => Preview(document, create.Replace("ENG-Volume", "ENG-BadVolume").Replace("ENG-Comparison", "ENG-Base")),
            "same base and comparison surface refused");
        Reject(() => Preview(document, create.Replace("ENG-Volume", "ENG-BadVolume").Replace("ENG-Comparison", "ENG-Disjoint")),
            "disjoint volume source ranges refused");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "volume.edit", ["surface"] = handle,
            ["fillFactor"] = 0 }.ToJsonString()), "nonpositive volume factor refused");
        Apply(document, new JsonObject { ["operation"] = "volume.edit", ["surface"] = handle,
            ["fillFactor"] = 1.1, ["description"] = "volume edited" }.ToJsonString());
        JsonObject read = ReadResult("VolumeChanges", "Get", document, handle);
        Check(Math.Abs(read["adjustedFill"]!.GetValue<double>() - 11000) < 1e-5
            && read["baseSurface"]!["name"]!.GetValue<string>() == "ENG-Base", "volume factor edit retains source surfaces");
        string id = ApplyGuardedCivil(document, new JsonObject { ["operation"] = "volume.edit", ["surface"] = handle,
            ["fillFactor"] = 1.5 }.ToJsonString());
        Invoke("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = id });
        Check(Math.Abs(ReadResult("VolumeChanges", "Get", document, handle)["fillFactor"]!.GetValue<double>() - 1.1) < 1e-8,
            "volume native edit Undo restores factors");
        string second = create.Replace("ENG-Volume", "ENG-UndoVolume");
        JsonObject plan = Preview(document, second);
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            Invoke("VolumeChanges", "Apply", document.Database, transaction, plan["request"]!.AsObject());
        }

        Preview(document, second);
        Check(true, "volume creation transaction rollback restores free name");
        id = ApplyGuardedCivil(document, second);
        Invoke("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = id });
        Preview(document, second);
        Check(true, "volume native creation Undo restores free name");
        JsonObject stale = Preview(document, second);
        Apply(document, """{"operation":"surface.edit","surface":"ENG-Base","elevationDelta":1}""");
        Reject(() => Invoke("CivilPlans", "Apply", document, new JsonObject { ["plan"] = stale }),
            "volume source geometry change invalidates previous plan");
    }

    private static JsonObject Xyz(double x, double y, double z) => new() { ["x"] = x, ["y"] = y, ["z"] = z };
}
