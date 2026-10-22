using System.IO;
using Assembly = System.Reflection.Assembly;
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
    [CommandMethod("MYC3DNETWORKTEST")]
    public void TestNetworkDrawing()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        string? failure = null;
        try
        {
            _plugin = Assembly.LoadFrom(Path.Combine(folder, "MyCivil3DMcp.Plugin.dll"));
            Document document = App.DocumentManager.MdiActiveDocument;
            Database database = document.Database;
            CivilDocument civil = CivilDocument.GetCivilDocument(database);
            ObjectId populated;
            ObjectId[] owned;
            ObjectId keep;
            ObjectId[] otherNetworks;
            using (Transaction transaction = database.TransactionManager.StartTransaction())
            {
                Network network = civil.GetPipeNetworkIds().Cast<ObjectId>()
                    .Select(id => (Network)transaction.GetObject(id, OpenMode.ForWrite))
                    .First(item => item.GetPipeIds().Count > 0 && item.GetStructureIds().Count > 0);
                populated = network.ObjectId;
                owned = network.GetPipeIds().Cast<ObjectId>().Concat(network.GetStructureIds().Cast<ObjectId>()).ToArray();
                network.Name = "Raker-KickerBlock (22)";
                otherNetworks = civil.GetPipeNetworkIds().Cast<ObjectId>().Where(id => id != populated).ToArray();
                for (int i = 0; i < 55; i++)
                {
                    string name = $"OTHER-{i:D2}";
                    Network.Create(civil, ref name);
                }
                string keepName = "1_계획_Raker";
                keep = Network.Create(civil, ref keepName);
                string emptyName = "Raker-KickerBlock (empty)";
                Network.Create(civil, ref emptyName);
                transaction.Commit();
            }
            Apply(document, new JsonObject { ["operation"] = "network.edit", ["network"] = populated.Handle.ToString(),
                ["description"] = "populated network metadata edit" }.ToJsonString());
            Check(owned.All(id => !id.IsErased), "populated network metadata edit preserves owned parts");
            JsonObject list = ReadResult("NetworkChanges", "List", document, "raker-kickerblock", 0, 1);
            Check(list["total"]!.GetValue<int>() == 2 && list["hasMore"]!.GetValue<bool>(),
                "network search filters all networks before paging, case insensitive");
            JsonObject next = ReadResult("NetworkChanges", "List", document, "raker-kickerblock", 1, 1);
            Check(next["items"]!.AsArray().Count == 1 && !next["hasMore"]!.GetValue<bool>(), "network search second page");
            string batch = """{"operation":"network.delete","nameContains":"Raker-KickerBlock"}""";
            JsonObject plan = Preview(document, batch);
            Check(plan["request"]!["networks"]!.AsArray().Count == 2 && !populated.IsErased && owned.All(id => !id.IsErased),
                "network preview includes numbered and empty networks without mutation");
            Check(plan["details"]!.ToJsonString().Contains("(22)") && plan["request"]!["targets"]!.AsArray().Count >= owned.Length + 2,
                "network plan contains owned pipes, structures and explicit network details");
            Reject(() => Preview(document, """{"operation":"network.delete","nameContains":" "}"""), "empty network selector refused");
            Reject(() => Preview(document, """{"operation":"network.delete","nameContains":"NO-SUCH-NETWORK"}"""), "unmatched network selector refused");
            Reject(() => Preview(document, """{"operation":"network.delete","network":"1_계획_Raker","networks":["1_계획_Raker"]}"""), "multiple network selectors refused");

            ObjectId partLayer;
            using (Transaction transaction = database.TransactionManager.StartTransaction())
            {
                var part = (Autodesk.AutoCAD.DatabaseServices.Entity)transaction.GetObject(owned[0], OpenMode.ForRead);
                partLayer = part.LayerId;
                ((LayerTableRecord)transaction.GetObject(partLayer, OpenMode.ForWrite)).IsLocked = true;
                transaction.Commit();
            }
            Reject(() => Preview(document, batch), "locked owned part blocks whole network batch");
            Check(!populated.IsErased && owned.All(id => !id.IsErased), "blocked network batch preserves all parts");
            using (Transaction transaction = database.TransactionManager.StartTransaction())
            {
                ((LayerTableRecord)transaction.GetObject(partLayer, OpenMode.ForWrite)).IsLocked = false;
                ((Network)transaction.GetObject(populated, OpenMode.ForWrite)).Name = "Raker-KickerBlock renamed";
                transaction.Commit();
            }
            Reject(() => Invoke("CivilPlans", "Apply", document, new JsonObject { ["plan"] = plan.DeepClone() }),
                "renamed network invalidates previous plan");
            plan = Preview(document, batch);
            using (Transaction transaction = database.TransactionManager.StartTransaction())
            {
                Invoke("NetworkChanges", "Apply", database, transaction, plan["request"]!.AsObject());
                // Dispose without Commit simulates failure after deletion; the full batch must roll back.
            }
            Check(!populated.IsErased && owned.All(id => !id.IsErased), "network batch transaction rollback restores all parts");

            plan = Preview(document, batch);
            JsonArray targets = plan["request"]!["targets"]!.AsArray();
            string[] handles = targets.Select(node => node!["Handle"]!.GetValue<string>()).ToArray();
            string operationId = Guid.NewGuid().ToString();
            JsonObject parameters = new() { ["operationId"] = operationId, ["plan"] = plan };
            JsonObject context = new()
            {
                ["drawingId"] = (string)Invoke("DrawingRevisions", "Id", database),
                ["revision"] = (string)Invoke("DrawingRevisions", "Of", database)
            };
            Invoke("DrawingOperations", "Apply", document, parameters, context,
                (Func<object>)(() => Invoke("CivilPlans", "Apply", document, parameters)));
            Check(populated.IsErased && owned.All(id => id.IsErased) && handles.All(handle => Erased(document, handle)),
                "network batch deletes networks, owned pipes, structures and discovered labels");
            Check(!keep.IsErased && otherNetworks.All(id => !id.IsErased), "network batch preserves unrelated networks");
            JsonObject undone = ReadResult("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = operationId });
            Check(undone["state"]?.ToString() == "undone" && !populated.IsErased && owned.All(id => !id.IsErased),
                "network native Undo restores network and all owned parts");
            Apply(document, new JsonObject { ["operation"] = "network.delete", ["network"] = keep.Handle.ToString() }.ToJsonString());
            Check(keep.IsErased, "single network deletion by handle");
            Apply(document, """{"operation":"network.delete","networks":["OTHER-00","OTHER-01","OTHER-00"]}""");
            Check(ReadResult("NetworkChanges", "List", document, "OTHER-0", 0, 50)["total"]!.GetValue<int>() == 8,
                "explicit network list deduplicates and preserves other networks");
            TestNetworkParts(document);
            database.SaveAs(Path.Combine(folder, "networks-edited.dwg"), DwgVersion.Current);
        }
        catch (System.Exception error) { failure = error.ToString(); }
        File.WriteAllText(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(new { passed = Passed, failure }, Json));
    }

    [CommandMethod("MYC3DNETWORKREOPENTEST")]
    public void TestReopenedNetwork()
    {
        string folder = Environment.GetEnvironmentVariable("MY_CIVIL3D_NATIVE_TEST_DIR")!;
        JsonObject previous = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "result.json")))!.AsObject();
        string[] passed = previous["passed"]!.AsArray().Select(node => node!.GetValue<string>()).ToArray();
        string? failure = null;
        try
        {
            _plugin = Assembly.LoadFrom(Path.Combine(folder, "MyCivil3DMcp.Plugin.dll"));
            Document document = App.DocumentManager.MdiActiveDocument;
            JsonObject parts = ReadResult("NetworkPartAccess", "List", document, "ENG-Network", null, 0, 50);
            Check(parts["total"]!.GetValue<int>() == 5, "saved gravity network retains straight and curved pipes and structures");
            Check(parts["items"]!.AsArray().Any(p => p!["name"]!.ToString() == "ENG-CurvedPipe"
                && p["geometry"]!["curved"]!.ToString() != "Straight"), "saved gravity curved pipe retains arc geometry");
            JsonNode pipe = parts["items"]!.AsArray().Single(node => node!["name"]!.ToString() == "ENG-Pipe")!;
            Check(pipe["geometry"]!["endStructure"] is null && pipe["geometry"]!["end"]!["x"]!.GetValue<double>() == 3250,
                "saved pipe retains explicit disconnection and geometry");
            string handle = pipe["handle"]!.GetValue<string>();
            Apply(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = handle,
                ["end"] = Xyz(3260, 3000, 96.5) }.ToJsonString());
            EntityCheck<Pipe>(document, handle, item => item.EndPoint.X == 3260, "saved pipe remains editable after reopening");
            JsonNode structure = parts["items"]!.AsArray().Single(node => node!["name"]!.ToString() == "ENG-End")!;
            Apply(document, new JsonObject { ["operation"] = "structure.edit", ["handle"] = structure["handle"]!.ToString(),
                ["rimElevation"] = 102 }.ToJsonString());
            Check(ReadResult("NetworkPartAccess", "List", document, "ENG-Network", "structure", 0, 50)["total"]!
                .GetValue<int>() == 3, "saved structure remains editable after reopening");
        }
        catch (System.Exception error)
        {
            failure = error.ToString();
        }

        File.WriteAllText(Path.Combine(folder, "result.json"), JsonSerializer.Serialize(
            new { passed = passed.Concat(Passed).ToArray(), failure }, Json));
    }
}
