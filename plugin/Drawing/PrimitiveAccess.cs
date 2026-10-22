using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

internal static class PrimitiveAccess
{
    public static IEnumerable<Entity> Entities(Database database, Transaction transaction, bool allLayouts)
    {
        BlockTable blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
        foreach (ObjectId id in blocks)
        {
            BlockTableRecord block = (BlockTableRecord)transaction.GetObject(id, OpenMode.ForRead);
            bool included = allLayouts ? block.IsLayout : block.ObjectId == database.CurrentSpaceId;
            if (!included || block.IsFromExternalReference || block.IsFromOverlayReference)
            {
                continue;
            }

            foreach (ObjectId entityId in block)
            {
                if (!entityId.IsErased && transaction.GetObject(entityId, OpenMode.ForRead) is Entity entity)
                {
                    yield return entity;
                }
            }
        }
    }

    public static Entity[] Targets<T>(Database database, Transaction transaction, JsonObject request) where T : Entity
    {
        Entity[] targets;
        if (request["all"]?.GetValue<bool>() == true && request["handles"] is not null)
        {
            throw new ArgumentException("객체 핸들과 전체 선택을 동시에 지정하지 마세요.");
        }

        if (request["all"]?.GetValue<bool>() == true)
        {
            targets = Entities(database, transaction, true).OfType<T>().Cast<Entity>().Take(1001).ToArray();
        }
        else
        {
            JsonArray handles = request["handles"] as JsonArray ?? throw new ArgumentException("객체 핸들이 필요합니다.");
            targets = handles.Select(node => CivilObjectAccess.ByHandle(transaction, database, node!.GetValue<string>()))
                .DistinctBy(entity => entity.ObjectId).ToArray();
        }

        if (targets.Length is < 1 or > 1000 || targets.Any(entity => entity is not T))
        {
            throw new ArgumentException($"{typeof(T).Name} 객체 1~1000개를 지정하세요.");
        }

        foreach (Entity entity in targets)
        {
            Writable(database, transaction, entity);
        }

        request["all"] = false;
        request["handles"] = new JsonArray(targets.Select(entity => JsonValue.Create(entity.Handle.ToString())).ToArray());
        return targets;
    }

    public static void Writable(Database database, Transaction transaction, Entity entity)
    {
        BlockTableRecord owner = (BlockTableRecord)transaction.GetObject(entity.OwnerId, OpenMode.ForRead);
        LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(entity.LayerId, OpenMode.ForRead);
        if (!owner.IsLayout || owner.IsFromExternalReference || layer.IsDependent || layer.IsLocked)
        {
            throw new ArgumentException($"[{entity.Handle}]은(는) 잠금·외부참조 또는 블록 정의 안의 객체여서 변경하지 않습니다.");
        }
    }

    public static Point3d Point(JsonNode? node) => new(CivilObjectAccess.Number(node?["x"]),
        CivilObjectAccess.Number(node?["y"]), CivilObjectAccess.Number(node?["z"]));

    public static JsonObject JsonPoint(Point3d point) => new() { ["x"] = point.X, ["y"] = point.Y, ["z"] = point.Z };

    // 보여 주기용 좌표·값. 요청에 넣는 정규화 좌표(JsonPoint)는 반올림하지 않는다.
    public static double[] DisplayPoint(Point3d point) =>
        [Math.Round(point.X, 3), Math.Round(point.Y, 3), Math.Round(point.Z, 3)];

    public static string PointText(Point3d point) =>
        FormattableString.Invariant($"({point.X:0.###}, {point.Y:0.###}, {point.Z:0.###})");

    public static string Number(double value) => FormattableString.Invariant($"{value:0.###}");

    // 계획 카드가 길어지지 않게 대상은 앞의 몇 개만 한 줄씩 보여 주고 나머지는 개수로 적는다.
    public static void AddItems(List<string> details, IReadOnlyList<string> lines, int shown = 20)
    {
        details.AddRange(lines.Take(shown));
        if (lines.Count > shown)
        {
            details.Add($"외 {lines.Count - shown}개 (모든 대상 핸들은 계획에 포함됨)");
        }
    }

    public static string ColorText(Autodesk.AutoCAD.Colors.Color color) =>
        color.IsByLayer ? "ByLayer" : color.IsByBlock ? "ByBlock"
        : color.IsByAci ? color.ColorIndex.ToString() : $"RGB {color.Red},{color.Green},{color.Blue}";

    public static Dictionary<string, int> CountBy<T>(IEnumerable<T> items, Func<T, string> key) =>
        items.GroupBy(key).OrderByDescending(group => group.Count()).ToDictionary(group => group.Key, group => group.Count());

    public static ObjectId Layer(Database database, Transaction transaction, JsonObject request)
    {
        ObjectId id = CivilObjectAccess.Layer(transaction, database, request["layer"]?.ToString());
        LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(id, OpenMode.ForRead);
        if (layer.IsLocked)
        {
            throw new ArgumentException($"레이어 {layer.Name}이(가) 잠겨 있습니다. 먼저 잠금을 해제하세요.");
        }

        request["layer"] = layer.Name;
        return id;
    }

    public static string[] Erase(Database database, Transaction transaction, JsonObject request)
    {
        string[] handles = ((JsonArray)request["handles"]!).Select(node => node!.GetValue<string>()).ToArray();
        foreach (string handle in handles)
        {
            Entity entity = CivilObjectAccess.ByHandle(transaction, database, handle);
            Entity writable = (Entity)transaction.GetObject(entity.ObjectId, OpenMode.ForWrite);
            writable.Erase();
        }

        return handles;
    }

    public static ObjectId Append(Database database, Transaction transaction, Entity entity)
    {
        BlockTableRecord space = (BlockTableRecord)transaction.GetObject(database.CurrentSpaceId, OpenMode.ForWrite);
        ObjectId id = space.AppendEntity(entity);
        transaction.AddNewlyCreatedDBObject(entity, true);
        return id;
    }
}
