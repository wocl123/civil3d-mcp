using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace CivilCrud.Native;

public partial class Commands
{
    private static void TestCreationExtensions(Document document)
    {
        Database database = document.Database;
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            CivilDocument.GetCivilDocument(database).Styles.ProfileViewStyles.Add("CRUD-View");
            transaction.Commit();
        }
        const string viewRequest = """
            {"operation":"profileView.create","name":"CRUD-View","alignment":"CRUD-Alignment",
            "position":{"x":1000,"y":1000,"z":0},"style":"CRUD-View"}
            """;
        JsonObject viewPlan = Preview(document, viewRequest);
        Check(ReadResult("ProfileViewChanges", "List", document, 0, 50)["total"]!.GetValue<int>() == 0,
            "profile view preview does not mutate drawing");
        string viewHandle = Apply(document, viewRequest)["handle"]!.GetValue<string>();
        EntityCheck<ProfileView>(document, viewHandle, view => view.Name == "CRUD-View"
            && view.Location.DistanceTo(new Point3d(1000, 1000, 0)) < 1e-9 && view.AlignmentName == "CRUD-Alignment",
            "profile view creates real alignment graph at explicit position");
        Reject(() => Preview(document, viewRequest), "duplicate profile view name refused");
        Apply(document, new JsonObject { ["operation"] = "profileView.edit", ["profileView"] = viewHandle,
            ["newName"] = "CRUD-View-Edited", ["description"] = "graph edited",
            ["position"] = new JsonObject { ["x"] = 1100, ["y"] = 1200, ["z"] = 0 } }.ToJsonString());
        EntityCheck<ProfileView>(document, viewHandle, view => view.Name == "CRUD-View-Edited"
            && view.Description == "graph edited" && view.Location.DistanceTo(new Point3d(1100, 1200, 0)) < 1e-9,
            "profile view edit keeps handle and moves graph");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "profileView.edit",
            ["profileView"] = viewHandle }.ToJsonString()), "empty profile view edit refused");
        Check(ReadResult("ProfileViewChanges", "List", document, 0, 1)["items"]!.AsArray().Count == 1,
            "profile view inventory returns created view");

        const string networkRequest = """
            {"operation":"network.create","name":"CRUD-NewNetwork","referenceAlignment":"CRUD-Alignment"}
            """;
        Preview(document, networkRequest);
        Check(ReadResult("NetworkChanges", "List", document, "CRUD-NewNetwork", 0, 50)["total"]!.GetValue<int>() == 0,
            "network creation preview does not mutate drawing");
        string networkHandle = Apply(document, networkRequest)["handle"]!.GetValue<string>();
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            Network network = CivilDocument.GetCivilDocument(database).GetPipeNetworkIds().Cast<ObjectId>()
                .Select(id => (Network)transaction.GetObject(id, OpenMode.ForRead))
                .Single(item => item.Handle.ToString() == networkHandle);
            Check(network.GetPipeIds().Count == 0 && network.GetStructureIds().Count == 0
                && network.ReferenceAlignmentName == "CRUD-Alignment", "empty gravity network with reference alignment");
        }
        Reject(() => Preview(document, networkRequest), "duplicate network create refused");
        Apply(document, new JsonObject { ["operation"] = "network.edit", ["network"] = networkHandle,
            ["newName"] = "CRUD-Network-Edited", ["description"] = "edited network" }.ToJsonString());
        JsonObject networkList = ReadResult("NetworkChanges", "List", document, "CRUD-Network-Edited", 0, 50);
        Check(networkList["total"]!.GetValue<int>() == 1, "network rename by handle");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "network.edit", ["network"] = networkHandle }
            .ToJsonString()), "empty network edit refused");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "network.edit", ["network"] = networkHandle,
            ["referenceSurface"] = "NO-SUCH-SURFACE" }.ToJsonString()), "unknown reference surface refused");

        string line = Apply(document, """
            {"operation":"geometry.create","kind":"line","points":[{"x":0,"y":0,"z":0},{"x":10,"y":0,"z":0}]}
            """)["created"]![0]!.GetValue<string>();
        JsonObject edit = new() { ["operation"] = "geometry.edit", ["handles"] = new JsonArray(line),
            ["basePoint"] = new JsonObject { ["x"] = 0, ["y"] = 0, ["z"] = 0 }, ["scale"] = 2,
            ["rotationDegrees"] = 90, ["moveBy"] = new JsonObject { ["x"] = 1, ["y"] = 2, ["z"] = 3 }, ["color"] = 1 };
        JsonObject stale = Preview(document, edit.ToJsonString());
        EntityCheck<Line>(document, line, entity => entity.EndPoint.DistanceTo(new Point3d(10, 0, 0)) < 1e-9,
            "geometry edit preview leaves source untouched");
        Apply(document, edit.ToJsonString());
        EntityCheck<Line>(document, line, entity => entity.StartPoint.DistanceTo(new Point3d(1, 2, 3)) < 1e-9
            && entity.EndPoint.DistanceTo(new Point3d(1, 22, 3)) < 1e-9 && entity.ColorIndex == 1,
            "geometry scale rotate move order and color keep handle");
        Reject(() => Invoke("CivilPlans", "Apply", document, new JsonObject { ["plan"] = stale }),
            "changed source geometry invalidates previous plan");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "geometry.edit", ["handles"] = new JsonArray(line),
            ["scale"] = 2 }.ToJsonString()), "geometry scale requires explicit base point");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "geometry.edit", ["handles"] = new JsonArray(line),
            ["radius"] = 2 }.ToJsonString()), "line radius edit refused");
        string circle = Apply(document, """
            {"operation":"geometry.create","kind":"circle","center":{"x":0,"y":0,"z":0},"radius":2}
            """)["created"]![0]!.GetValue<string>();
        Apply(document, new JsonObject { ["operation"] = "geometry.edit", ["handles"] = new JsonArray(circle),
            ["radius"] = 5 }.ToJsonString());
        EntityCheck<Circle>(document, circle, entity => entity.Radius == 5, "circle radius edit");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "geometry.edit", ["handles"] = new JsonArray(viewHandle),
            ["moveBy"] = new JsonObject { ["x"] = 1, ["y"] = 0, ["z"] = 0 } }.ToJsonString()),
            "Civil graph refused by ordinary geometry edit");
        foreach (var (type, request) in new[]
        {
            ("ProfileViewChanges", viewRequest.Replace("CRUD-View\"", "CRUD-UndoView\"", StringComparison.Ordinal)
                .Replace("\"style\":\"CRUD-UndoView\"", "\"style\":\"CRUD-View\"", StringComparison.Ordinal)),
            ("NetworkProperties", networkRequest.Replace("CRUD-NewNetwork", "CRUD-UndoNetwork", StringComparison.Ordinal))
        })
        {
            JsonObject plan = Preview(document, request);
            using (Transaction transaction = database.TransactionManager.StartTransaction())
            {
                Invoke(type, "Apply", database, transaction, plan["request"]!.AsObject());
            }
            // A rolled-back creation must leave its name available.
            Preview(document, request);
            Check(true, type + " uncommitted creation rolls back");
            string operationId = ApplyGuardedCivil(document, request);
            JsonObject undone = ReadResult("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = operationId });
            Check(undone["state"]?.ToString() == "undone", type + " creation supports guarded native Undo");
            Preview(document, request);
            Check(true, type + " native Undo restores free name");
        }
        string moveRequest = new JsonObject { ["operation"] = "geometry.edit", ["handles"] = new JsonArray(line),
            ["moveBy"] = new JsonObject { ["x"] = 5, ["y"] = 0, ["z"] = 0 } }.ToJsonString();
        string moveId = ApplyGuardedCivil(document, moveRequest);
        EntityCheck<Line>(document, line, entity => entity.StartPoint.DistanceTo(new Point3d(6, 2, 3)) < 1e-9,
            "guarded geometry edit changes source");
        Invoke("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = moveId });
        EntityCheck<Line>(document, line, entity => entity.StartPoint.DistanceTo(new Point3d(1, 2, 3)) < 1e-9,
            "geometry edit native Undo restores source");
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            ((LayerTableRecord)transaction.GetObject(database.Clayer, OpenMode.ForWrite)).IsLocked = true;
            transaction.Commit();
        }
        Reject(() => Preview(document, moveRequest), "locked layer blocks ordinary geometry edit");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "profileView.edit", ["profileView"] = viewHandle,
            ["description"] = "blocked" }.ToJsonString()), "locked layer blocks profile view edit");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "network.edit", ["network"] = networkHandle,
            ["description"] = "blocked" }.ToJsonString()), "locked layer blocks network property edit");
        Reject(() => Preview(document, networkRequest.Replace("CRUD-NewNetwork", "CRUD-LockedNetwork", StringComparison.Ordinal)),
            "locked destination layer blocks network creation");
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            ((LayerTableRecord)transaction.GetObject(database.Clayer, OpenMode.ForWrite)).IsLocked = false;
            transaction.Commit();
        }
    }

    private static string ApplyGuardedCivil(Document document, string request)
    {
        JsonObject plan = Preview(document, request);
        string operationId = Guid.NewGuid().ToString();
        JsonObject parameters = new() { ["operationId"] = operationId, ["plan"] = plan };
        JsonObject context = new() { ["drawingId"] = (string)Invoke("DrawingRevisions", "Id", document.Database),
            ["revision"] = (string)Invoke("DrawingRevisions", "Of", document.Database) };
        Invoke("DrawingOperations", "Apply", document, parameters, context,
            (Func<object>)(() => Invoke("CivilPlans", "Apply", document, parameters)));
        return operationId;
    }
}
