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
    private static void TestNetworkParts(Document document)
    {
        Database database = document.Database;
        CivilDocument civil = CivilDocument.GetCivilDocument(database);
        string listHandle;
        string pipeFamily;
        string firstSize;
        string secondSize;
        string structureFamily;
        string structureSize;
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            PartsList list = civil.GetPipeNetworkIds().Cast<ObjectId>()
                .Select(id => (Network)transaction.GetObject(id, OpenMode.ForRead))
                .Where(network => !network.PartsListId.IsNull)
                .Select(network => (PartsList)transaction.GetObject(network.PartsListId, OpenMode.ForRead))
                .First(item => item.GetPartFamilyIdsByDomain(DomainType.Pipe).Count > 0
                    && item.GetPartFamilyIdsByDomain(DomainType.Structure).Count > 0);
            listHandle = list.Handle.ToString();
            PartFamily pipes = list.GetPartFamilyIdsByDomain(DomainType.Pipe).Cast<ObjectId>()
                .Select(id => (PartFamily)transaction.GetObject(id, OpenMode.ForRead)).First(item => item.PartSizeCount > 1);
            pipeFamily = pipes.Handle.ToString();
            firstSize = pipes[0].Handle.ToString();
            secondSize = pipes[1].Handle.ToString();
            PartFamily structures = list.GetPartFamilyIdsByDomain(DomainType.Structure).Cast<ObjectId>()
                .Select(id => (PartFamily)transaction.GetObject(id, OpenMode.ForRead))
                .First(item => item.PartSizeCount > 0 && !item.Name.Contains("Null", StringComparison.OrdinalIgnoreCase));
            structureFamily = structures.Handle.ToString();
            structureSize = structures[0].Handle.ToString();
        }

        JsonObject lists = ReadResult("NetworkCatalog", "List", document, new JsonObject(), 0, 50);
        Check(lists["items"]!.AsArray().Count > 0, "gravity catalog lists drawing parts lists");
        JsonObject families = ReadResult("NetworkCatalog", "List", document,
            new JsonObject { ["partsList"] = listHandle, ["kind"] = "pipe" }, 0, 50);
        Check(families["items"]!.AsArray().Count > 0, "gravity catalog lists families by domain");
        JsonObject sizes = ReadResult("NetworkCatalog", "List", document,
            new JsonObject { ["partsList"] = listHandle, ["kind"] = "pipe", ["family"] = pipeFamily }, 0, 1);
        Check(sizes["items"]!.AsArray().Count == 1 && sizes["hasMore"]!.GetValue<bool>(), "gravity catalog sizes are paged");

        string network = Apply(document, new JsonObject { ["operation"] = "network.create", ["name"] = "ENG-Network",
            ["partsList"] = listHandle }.ToJsonString())["handle"]!.GetValue<string>();
        string CreateStructure(string name, double x, double z) => Apply(document, new JsonObject
        {
            ["operation"] = "structure.create", ["network"] = network, ["name"] = name,
            ["family"] = structureFamily, ["size"] = structureSize, ["position"] = Xyz(x, 3000, z),
            ["rimElevation"] = z, ["sumpElevation"] = z - 10
        }.ToJsonString())["part"]!["handle"]!.GetValue<string>();
        string start = CreateStructure("ENG-Start", 3000, 100);
        string end = CreateStructure("ENG-End", 3100, 99);
        EntityCheck<Structure>(document, start, structure => structure.Location.X == 3000
            && Math.Abs(structure.RimElevation - 100) < 1e-6 && Math.Abs(structure.SumpElevation - 90) < 1e-6,
            "real catalog structure creation sets position rim and sump");

        JsonObject pipeRequest = new() { ["operation"] = "pipe.create", ["network"] = network, ["name"] = "ENG-Pipe",
            ["family"] = pipeFamily, ["size"] = firstSize, ["start"] = Xyz(3000, 3000, 97), ["end"] = Xyz(3100, 3000, 96),
            ["startStructure"] = start, ["endStructure"] = end };
        Preview(document, pipeRequest.ToJsonString());
        Check(ReadResult("NetworkPartAccess", "List", document, network, "pipe", 0, 50)["total"]!.GetValue<int>() == 0,
            "pipe preview does not add parts");
        string pipe = Apply(document, pipeRequest.ToJsonString())["part"]!["handle"]!.GetValue<string>();
        EntityCheck<Pipe>(document, pipe, part => part.StartStructureId.Handle.ToString() == start
            && part.EndStructureId.Handle.ToString() == end && Math.Abs(part.StartPoint.Z - 97) < 1e-6,
            "real catalog straight pipe creation connects both structure endpoints");
        JsonObject read = ReadResult("NetworkPartAccess", "List", document, network, null, 0, 50);
        Check(read["total"]!.GetValue<int>() == 3, "network part list returns created pipes and structures");
        Reject(() => Preview(document, pipeRequest.ToJsonString()), "duplicate network part name refused");
        JsonObject badSize = pipeRequest.DeepClone().AsObject();
        badSize["name"] = "ENG-BadSize";
        badSize["size"] = "NO-SUCH-SIZE";
        Reject(() => Preview(document, badSize.ToJsonString()), "unknown pipe catalog size refused");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["family"] = pipeFamily }.ToJsonString()), "size change requires full family size pair");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["start"] = Xyz(3001, 3000, 97) }.ToJsonString()), "connected pipe cannot silently move away from structure");

        JsonObject oldPlan = Preview(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["description"] = "stale" }.ToJsonString());
        Apply(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["start"] = Xyz(3000, 3000, 97.5), ["end"] = Xyz(3100, 3000, 96.5) }.ToJsonString());
        EntityCheck<Pipe>(document, pipe, part => Math.Abs(part.StartPoint.Z - 97.5) < 1e-6
            && Math.Abs(part.EndPoint.Z - 96.5) < 1e-6 && !part.StartStructureId.IsNull,
            "connected pipe centerline elevation edit preserves connections");
        Reject(() => Invoke("CivilPlans", "Apply", document, new JsonObject { ["plan"] = oldPlan }),
            "changed pipe geometry invalidates previous plan");
        double width;
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            width = ((Pipe)transaction.GetObject(Id(database, pipe), OpenMode.ForRead)).InnerDiameterOrWidth;
        }

        Apply(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["family"] = pipeFamily, ["size"] = secondSize }.ToJsonString());
        EntityCheck<Pipe>(document, pipe, part => part.InnerDiameterOrWidth != width
            && Math.Abs(part.StartPoint.Z - 97.5) < 1e-6, "exact catalog pipe size swap preserves centerline");
        string operationId = ApplyGuardedCivil(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["start"] = Xyz(3000, 3000, 98) }.ToJsonString());
        Invoke("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = operationId });
        EntityCheck<Pipe>(document, pipe, part => Math.Abs(part.StartPoint.Z - 97.5) < 1e-6, "pipe native edit Undo");

        Apply(document, new JsonObject { ["operation"] = "structure.edit", ["handle"] = end,
            ["rimElevation"] = 101, ["sumpElevation"] = 88, ["rotationDegrees"] = 30 }.ToJsonString());
        EntityCheck<Structure>(document, end, part => Math.Abs(part.RimElevation - 101) < 1e-6
            && Math.Abs(part.SumpElevation - 88) < 1e-6 && Math.Abs(part.Rotation - Math.PI / 6) < 1e-6,
            "connected structure rim sump and rotation edit");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "structure.edit", ["handle"] = end,
            ["sumpElevation"] = 102 }.ToJsonString()), "structure sump above rim refused");
        string third = CreateStructure("ENG-Third", 3200, 100);
        Reject(() => Preview(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["endStructure"] = third }.ToJsonString()), "replacing pipe connection requires explicit flag");
        Apply(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["endStructure"] = third, ["end"] = Xyz(3200, 3000, 96.5), ["replaceConnections"] = true }.ToJsonString());
        EntityCheck<Pipe>(document, pipe, part => part.EndStructureId.Handle.ToString() == third,
            "explicit pipe connection replacement");
        Apply(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["disconnectEnd"] = true, ["end"] = Xyz(3250, 3000, 96.5) }.ToJsonString());
        EntityCheck<Pipe>(document, pipe, part => part.EndStructureId.IsNull && part.EndPoint.X == 3250,
            "explicit pipe disconnection permits coordinate move");

        TestPartCreationUndo(document, database, network, pipeFamily, firstSize, structureFamily, structureSize);
        string curved = Apply(document, new JsonObject { ["operation"] = "pipe.create", ["network"] = network,
            ["name"] = "ENG-CurvedPipe", ["family"] = pipeFamily, ["size"] = firstSize,
            ["start"] = Xyz(4000, 3200, 97), ["end"] = Xyz(4100, 3200, 96), ["curveBulge"] = 0.4 }.ToJsonString())["part"]!["handle"]!.ToString();
        EntityCheck<Pipe>(document, curved, p => p.SubEntityType != PipeSubEntityType.Straight,
            "gravity curved pipe creates actual catalog arc geometry");
        using (Transaction tr = database.TransactionManager.StartTransaction())
        {
            var styles = Autodesk.Civil.ApplicationServices.CivilDocument.GetCivilDocument(database).Styles;
            styles.LabelStyles.PipeLabelStyles.PlanProfileLabelStyles.Add("T3-NetworkPipeLabel");
            styles.LabelStyles.StructureLabelStyles.LabelStyles.Add("T3-NetworkStructureLabel"); tr.Commit();
        }
        string pipeLabel = Apply(document, new JsonObject { ["operation"] = "label.engineering", ["kind"] = "pipe", ["source"] = curved, ["style"] = "T3-NetworkPipeLabel", ["ratio"] = 0.5 }.ToJsonString())["handle"]!.ToString();
        EntityCheck<PipeLabel>(document, pipeLabel, _ => true, "actual gravity pipe Civil label creation");
        string structureLabel = Apply(document, new JsonObject { ["operation"] = "label.engineering", ["kind"] = "structure", ["source"] = start, ["style"] = "T3-NetworkStructureLabel", ["position"] = Xyz(3000, 3010, 100) }.ToJsonString())["handle"]!.ToString();
        EntityCheck<StructureLabel>(document, structureLabel, _ => true, "actual gravity structure Civil label creation");
        ObjectId layer;
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            layer = ((Structure)transaction.GetObject(Id(database, start), OpenMode.ForRead)).LayerId;
            ((LayerTableRecord)transaction.GetObject(layer, OpenMode.ForWrite)).IsLocked = true;
            transaction.Commit();
        }

        Reject(() => Preview(document, new JsonObject { ["operation"] = "pipe.edit", ["handle"] = pipe,
            ["description"] = "blocked" }.ToJsonString()), "locked related structure layer blocks network edit");
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            ((LayerTableRecord)transaction.GetObject(layer, OpenMode.ForWrite)).IsLocked = false;
            transaction.Commit();
        }
    }

    private static void TestPartCreationUndo(Document document, Database database, string network,
        string pipeFamily, string pipeSize, string structureFamily, string structureSize)
    {
        foreach (JsonObject request in new[]
        {
            new JsonObject { ["operation"] = "pipe.create", ["network"] = network, ["name"] = "ENG-UndoPipe",
                ["family"] = pipeFamily, ["size"] = pipeSize, ["start"] = Xyz(4000, 3000, 97), ["end"] = Xyz(4100, 3000, 96) },
            new JsonObject { ["operation"] = "structure.create", ["network"] = network, ["name"] = "ENG-UndoStructure",
                ["family"] = structureFamily, ["size"] = structureSize, ["position"] = Xyz(4000, 3100, 100) }
        })
        {
            JsonObject plan = Preview(document, request.ToJsonString());
            using (Transaction transaction = database.TransactionManager.StartTransaction())
            {
                Invoke("NetworkPartChanges", "Apply", database, transaction, plan["request"]!.AsObject());
            }

            Preview(document, request.ToJsonString());
            Check(true, request["operation"] + " transaction rollback restores free name");
            string id = ApplyGuardedCivil(document, request.ToJsonString());
            Invoke("DrawingOperations", "Undo", document, new JsonObject { ["operationId"] = id });
            Preview(document, request.ToJsonString());
            Check(true, request["operation"] + " native Undo restores free name");
        }
    }

    private static ObjectId Id(Database database, string handle) => database.GetObjectId(false,
        new Handle(Convert.ToInt64(handle, 16)), 0);
}
