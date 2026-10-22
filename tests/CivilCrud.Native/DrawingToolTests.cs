using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace CivilCrud.Native;

// 2026-10-19 수정요청: 치수 표시 형식, 기본 도형 그리기, 문자 조회·수정, 정리 검사 범위.
public partial class Commands
{
    private static void TestDrawingTools(Document document)
    {
        TestDimensionDisplay(document);
        TestTexts(document);
        TestGeometry(document);
        TestCleanupScope(document);
    }

    private static void TestDimensionDisplay(Document document)
    {
        JsonObject created = Apply(document, """
            {"operation":"dimension.create","kind":"aligned","start":{"x":20,"y":0,"z":0},
            "end":{"x":0,"y":20,"z":0},"location":{"x":30,"y":30,"z":0}}
            """);
        string handle = created["created"]![0]!.GetValue<string>();
        Apply(document, new JsonObject { ["operation"] = "dimension.edit", ["handles"] = new JsonArray(handle),
            ["text"] = "검토 <>" }.ToJsonString());
        JsonObject list = ReadResult("DimensionChanges", "List", document, 0, 200);
        JsonNode item = list["items"]!.AsArray().Single(node => node!["handle"]!.GetValue<string>() == handle)!;
        Check(item["kind"]!.GetValue<string>() == "정렬" && item["measurement"]!.GetValue<double>() == 28.284
            && item["text"]!.GetValue<string>() == "검토 28.284" && list["byKind"]!["정렬"] is not null,
            "dimension list shows Korean kind, rounded value and shown text");
        JsonObject plan = Preview(document, """{"operation":"dimension.delete","all":true}""");
        string[] details = plan["details"]!.AsArray().Select(node => node!.GetValue<string>()).ToArray();
        Check(details.All(line => !line.Contains('{')) && details.Any(line => line.Contains("정렬 치수 [" + handle + "]")),
            "dimension plan details are readable lines, not raw JSON");
        Apply(document, """{"operation":"dimension.delete","all":true}""");
    }

    private static void TestTexts(Document document)
    {
        string single = Apply(document, """
            {"operation":"text.create","content":"EL 43.971","position":{"x":100,"y":100,"z":0},"height":2.5}
            """)["created"]![0]!.GetValue<string>();
        string multi = Apply(document, """
            {"operation":"text.create","kind":"multi","content":"첫 줄\n둘째 EL","position":{"x":100,"y":90,"z":0}}
            """)["created"]![0]!.GetValue<string>();
        JsonObject list = ReadResult("TextChanges", "List", document, new JsonObject { ["contains"] = "EL" }, 0, 50);
        JsonNode first = list["items"]!.AsArray().Single(node => node!["handle"]!.GetValue<string>() == single)!;
        Check(list["totalCount"]!.GetValue<int>() == 2 && first["content"]!.GetValue<string>() == "EL 43.971"
            && first["height"]!.GetValue<double>() == 2.5 && first["kind"]!.GetValue<string>() == "한 줄",
            "text list reads content, height and kind with contains filter");

        Apply(document, """{"operation":"text.edit","all":true,"contains":"EL","find":"EL","replace":"H","color":1}""");
        EntityCheck<DBText>(document, single, text => text.TextString == "H 43.971" && text.ColorIndex == 1,
            "text find/replace and colour on single-line text");
        EntityCheck<MText>(document, multi, text => text.Text.Replace("\r\n", "\n") == "첫 줄\n둘째 H",
            "text find/replace keeps multiline lines");
        Apply(document, new JsonObject { ["operation"] = "text.edit", ["handles"] = new JsonArray(single),
            ["height"] = 5, ["rotationDegrees"] = 90, ["moveBy"] = new JsonObject { ["x"] = 1, ["y"] = 2, ["z"] = 0 }
        }.ToJsonString());
        EntityCheck<DBText>(document, single, text => text.Height == 5 && Math.Abs(text.Rotation - Math.PI / 2) < 1e-9
            && text.Position.DistanceTo(new Point3d(101, 102, 0)) < 1e-9, "text height, rotation and move");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "text.edit", ["handles"] = new JsonArray(single),
            ["find"] = "없는문자", ["replace"] = "x" }.ToJsonString()), "text find refuses targets without match");
        Apply(document, new JsonObject { ["operation"] = "text.delete", ["handles"] = new JsonArray(single, multi)
        }.ToJsonString());
        Check(ReadResult("TextChanges", "List", document, null, 0, 50)["totalCount"]!.GetValue<int>() == 0,
            "text deletion");
    }

    private static void TestGeometry(Document document)
    {
        JsonObject plan = Preview(document, """
            {"operation":"geometry.create","kind":"rectangle","points":[{"x":0,"y":0,"z":0}],"width":10,"height":5}
            """);
        Check(plan["summary"]!.GetValue<string>() == "직사각형 1개 그리기"
            && plan["details"]!.AsArray().Any(node => node!.GetValue<string>().Contains("면적 50")),
            "rectangle plan from corner and size");
        string rectangle = Apply(document, plan["request"]!.ToJsonString())["created"]![0]!.GetValue<string>();
        EntityCheck<Polyline>(document, rectangle, line => line.Closed && line.NumberOfVertices == 4
            && Math.Abs(line.Area - 50) < 1e-9 && line.GetPoint3dAt(2).DistanceTo(new Point3d(10, 5, 0)) < 1e-9,
            "rectangle drawn as closed polyline at WCS corners");
        string circle = Apply(document, """
            {"operation":"geometry.create","kind":"circle","center":{"x":0,"y":0,"z":0},"radius":3}
            """)["created"]![0]!.GetValue<string>();
        string arc = Apply(document, """
            {"operation":"geometry.create","kind":"arc","center":{"x":0,"y":0,"z":0},"radius":3,
            "startAngleDegrees":0,"endAngleDegrees":90}
            """)["created"]![0]!.GetValue<string>();
        string line = Apply(document, """
            {"operation":"geometry.create","kind":"line","points":[{"x":0,"y":0,"z":0},{"x":3,"y":4,"z":0}]}
            """)["created"]![0]!.GetValue<string>();
        EntityCheck<Line>(document, line, item => Math.Abs(item.Length - 5) < 1e-9, "line drawn");
        Reject(() => Preview(document, """
            {"operation":"geometry.create","kind":"polyline","points":[{"x":0,"y":0,"z":0},{"x":1,"y":0,"z":2}]}
            """), "geometry refuses points on different Z");
        Apply(document, new JsonObject { ["operation"] = "geometry.delete",
            ["handles"] = new JsonArray(rectangle, circle, arc, line) }.ToJsonString());
        Check(Erased(document, line) && Erased(document, rectangle), "geometry deletion");
    }

    private static void TestCleanupScope(Document document)
    {
        string frozenZero, lockedZero, linked, pointCopy, blockCopy, emptyBlock;
        using (Transaction transaction = document.Database.TransactionManager.StartTransaction())
        {
            Database database = document.Database;
            LayerTable layers = (LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForWrite);
            ObjectId Layer(string name, bool frozen, bool locked)
            {
                using LayerTableRecord layer = new() { Name = name, IsFrozen = frozen, IsLocked = locked };
                ObjectId id = layers.Add(layer);
                transaction.AddNewlyCreatedDBObject(layer, true);
                return id;
            }

            ObjectId frozen = Layer("CLEAN-Frozen", true, false);
            ObjectId locked = Layer("CLEAN-Locked", false, true);
            BlockTable blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForWrite);
            ObjectId Block(string name, bool empty)
            {
                using BlockTableRecord block = new() { Name = name };
                ObjectId id = blocks.Add(block);
                transaction.AddNewlyCreatedDBObject(block, true);
                if (!empty)
                {
                    using Circle circle = new(Point3d.Origin, Vector3d.ZAxis, 1);
                    block.AppendEntity(circle);
                    transaction.AddNewlyCreatedDBObject(circle, true);
                }

                return id;
            }

            ObjectId marker = Block("CLEAN-Marker", false);
            ObjectId hollow = Block("CLEAN-Empty", true);
            BlockTableRecord space = (BlockTableRecord)transaction.GetObject(database.CurrentSpaceId, OpenMode.ForWrite);
            string Append(Entity entity)
            {
                ObjectId id = space.AppendEntity(entity);
                transaction.AddNewlyCreatedDBObject(entity, true);
                return id.Handle.ToString();
            }

            Point3d at = new(700, 700, 0);
            frozenZero = Append(new Line(at, at) { LayerId = frozen });
            lockedZero = Append(new Line(at, at) { LayerId = locked });
            RegAppTable apps = (RegAppTable)transaction.GetObject(database.RegAppTableId, OpenMode.ForWrite);
            using (RegAppTableRecord app = new() { Name = "CLEAN_TEST" })
            {
                apps.Add(app);
                transaction.AddNewlyCreatedDBObject(app, true);
            }

            using ResultBuffer data = new(new TypedValue((int)DxfCode.ExtendedDataRegAppName, "CLEAN_TEST"),
                new TypedValue((int)DxfCode.ExtendedDataAsciiString, "linked"));
            Line link = new(at, at);
            linked = Append(link);
            link.XData = data;
            Append(new DBPoint(at));
            pointCopy = Append(new DBPoint(at));
            Append(new BlockReference(at, marker));
            blockCopy = Append(new BlockReference(at, marker));
            emptyBlock = Append(new BlockReference(new Point3d(710, 700, 0), hollow));
            transaction.Commit();
        }

        JsonObject result = ReadResult("DrawingCleanup", "Inspect", document, 0, 200);
        Dictionary<string, JsonNode> items = result["items"]!.AsArray()
            .ToDictionary(node => node!["handle"]!.GetValue<string>(), node => node!);
        bool Has(string handle, string caution) =>
            items.TryGetValue(handle, out JsonNode? item) && item["cautions"]!.AsArray().Any(node =>
                node!.GetValue<string>().Contains(caution));
        Check(Has(frozenZero, "동결") && Has(lockedZero, "잠긴") && Has(linked, "연결 데이터"),
            "cleanup scans frozen, locked and linked-data objects with cautions");
        Check(items.ContainsKey(pointCopy) && items.ContainsKey(blockCopy) && items.ContainsKey(emptyBlock),
            "cleanup reports duplicate points, duplicate block references and empty block references");
        Check(!items[lockedZero]["deletable"]!.GetValue<bool>() && items[frozenZero]["deletable"]!.GetValue<bool>(),
            "cleanup marks locked-layer candidates not deletable");
        Reject(() => Preview(document, new JsonObject { ["operation"] = "cleanup.delete",
            ["handles"] = new JsonArray(lockedZero) }.ToJsonString()), "cleanup refuses locked-layer candidate");
        Apply(document, new JsonObject { ["operation"] = "cleanup.delete",
            ["handles"] = new JsonArray(frozenZero, linked, pointCopy, blockCopy, emptyBlock) }.ToJsonString());
        Check(Erased(document, pointCopy) && Erased(document, blockCopy), "cleanup deletes chosen duplicates");
    }

    private static bool Erased(Document document, string handle) =>
        document.Database.GetObjectId(false, new Handle(Convert.ToInt64(handle, 16)), 0).IsErased;
}
