using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;
using DBObject = Autodesk.AutoCAD.DatabaseServices.DBObject;

namespace MyCivil3DMcp.Plugin;

// 모형·배치·블록 정의의 객체와 관망 종속 객체를 읽는다. 계획에서 확인한 객체만 삭제한다.
internal static class LayerObjects
{
    public sealed record Target(string Handle, string Type, string Layer);
    public sealed record Inventory(IReadOnlyList<Target> Objects, IReadOnlyList<string> Effects, string? Blocked);
    private const int Limit = 1000;

    public static Dictionary<string, Inventory> Read(Database database, Transaction transaction,
        IEnumerable<string> names)
    {
        List<Entity> entities = AllEntities(database, transaction);
        Dictionary<string, Inventory> result = new(StringComparer.OrdinalIgnoreCase);
        foreach (string name in names)
        {
            List<Entity> direct = entities
                .Where(entity => entity.Layer.Equals(name, StringComparison.OrdinalIgnoreCase))
                .ToList();
            result[name] = Describe(transaction, direct);
        }

        return result;
    }

    private static List<Entity> AllEntities(Database database, Transaction transaction)
    {
        Dictionary<ObjectId, Entity> entities = new();
        BlockTable blocks = (BlockTable)transaction.GetObject(database.BlockTableId, OpenMode.ForRead);
        foreach (ObjectId id in blocks)
        {
            BlockTableRecord block = (BlockTableRecord)transaction.GetObject(id, OpenMode.ForRead);
            if (block.IsFromExternalReference)
            {
                continue;
            }

            foreach (ObjectId objectId in block)
            {
                Add(transaction, entities, objectId);
            }
        }

        CivilDocument? civil = CivilApplication.ActiveDocument;
        if (civil is not null)
        {
            foreach (ObjectId id in civil.GetPipeNetworkIds())
            {
                Add(transaction, entities, id);
                Network network = (Network)transaction.GetObject(id, OpenMode.ForRead);
                foreach (ObjectId part in NetworkParts(network))
                {
                    Add(transaction, entities, part);
                }
            }

            foreach (ObjectId id in civil.CogoPoints)
            {
                Add(transaction, entities, id);
            }
        }

        return entities.Values.ToList();
    }

    internal static Inventory Describe(Transaction transaction, IReadOnlyList<Entity> direct)
    {
        Dictionary<ObjectId, Entity> objects = direct.ToDictionary(entity => entity.ObjectId);
        List<string> effects = new();
        foreach (Entity entity in direct)
        {
            DBObject owner = transaction.GetObject(entity.OwnerId, OpenMode.ForRead);
            BlockTableRecord? block = owner as BlockTableRecord;
            bool definition = block is not null && !block.IsLayout;
            if (definition)
            {
                effects.Add($"블록 {block!.Name}의 정의가 바뀌어 이 블록의 모든 배치에 반영됩니다.");
            }

            if (entity is Network network)
            {
                foreach (ObjectId part in NetworkParts(network))
                {
                    Add(transaction, objects, part);
                }

                effects.Add($"관망 {network.Name}과 소속 관·구조물도 함께 삭제합니다(다른 레이어의 객체 포함).");
            }
            else if (entity is Pipe or Structure)
            {
                effects.Add("관·구조물 삭제로 남아 있는 관망 객체의 접속 정보가 갱신될 수 있습니다.");
            }
        }

        AddLabels(transaction, objects);
        string? blocked = Blocked(objects.Values);
        Target[] targets = objects.Values.Select(entity =>
            new Target(entity.Handle.ToString(), entity.GetType().Name, entity.Layer)).ToArray();
        return new Inventory(targets, effects.Distinct().ToArray(), blocked);
    }

    // Civil 객체가 지워질 때 함께 사라지는 라벨도 미리 보여 준다.
    private static void AddLabels(Transaction transaction, Dictionary<ObjectId, Entity> objects)
    {
        Queue<Entity> remaining = new(objects.Values);
        while (remaining.TryDequeue(out Entity? entity))
        {
            foreach (ObjectId id in entity.GetPersistentReactorIds())
            {
                if (id.IsNull || id.IsErased || objects.ContainsKey(id))
                {
                    continue;
                }

                DBObject reactor = transaction.GetObject(id, OpenMode.ForRead);
                bool label = reactor is Entity && reactor.GetType().Name.Contains("Label", StringComparison.Ordinal);
                if (label)
                {
                    Entity dependent = (Entity)reactor;
                    objects[id] = dependent;
                    remaining.Enqueue(dependent);
                }
            }

            if (objects.Count > Limit)
            {
                throw new ArgumentException("한 번에 처리할 객체는 1000개 이하로 나누어 요청하세요.");
            }
        }
    }

    private static string? Blocked(IEnumerable<Entity> entities)
    {
        foreach (Entity entity in entities)
        {
            if (entity is Autodesk.Civil.DatabaseServices.Entity civil)
            {
                if (civil.IsReferenceObject || civil.IsReferenceSubObject)
                {
                    return "다른 도면에서 참조한 Civil 객체는 삭제하지 않습니다.";
                }

                bool supported = civil is Network or Pipe or Structure
                    || civil.GetType().Name.Contains("Label", StringComparison.Ordinal);
                if (!supported)
                {
                    return $"{civil.GetType().Name}의 연관 삭제는 아직 지원하지 않습니다. 전용 객체 삭제 도구를 쓰세요.";
                }
            }
        }

        return null;
    }

    private static IEnumerable<ObjectId> NetworkParts(Network network) =>
        network.GetPipeIds().Cast<ObjectId>().Concat(network.GetStructureIds().Cast<ObjectId>());

    private static void Add(Transaction transaction, Dictionary<ObjectId, Entity> entities, ObjectId id)
    {
        if (id.IsNull || id.IsErased || entities.ContainsKey(id))
        {
            return;
        }

        DBObject value = transaction.GetObject(id, OpenMode.ForRead);
        if (value is Entity entity)
        {
            entities[id] = entity;
        }
    }

    public static void Erase(Database database, Transaction transaction, IReadOnlyList<Target> targets)
    {
        if (targets.Count > Limit)
        {
            throw new ArgumentException("한 번에 삭제할 객체는 1000개 이하로 나누어 요청하세요.");
        }

        List<Entity> entities = targets.Select(target => Open(database, transaction, target)).ToList();
        foreach (Entity entity in entities.OrderBy(entity => entity is Network ? 1 : 0))
        {
            if (!entity.IsErased)
            {
                Entity writable = (Entity)transaction.GetObject(entity.ObjectId, OpenMode.ForWrite, false, true);
                writable.Erase();
            }
        }
    }

    private static Entity Open(Database database, Transaction transaction, Target target)
    {
        bool valid = long.TryParse(target.Handle, System.Globalization.NumberStyles.HexNumber, null, out long value);
        if (!valid || !database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased)
        {
            throw new ArgumentException("삭제 대상 객체가 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
        }

        DBObject item = transaction.GetObject(id, OpenMode.ForRead);
        bool same = item is Entity && item.GetType().Name == target.Type;
        if (!same)
        {
            throw new ArgumentException("삭제 대상 객체의 종류가 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
        }

        Entity entity = (Entity)item;
        if (!entity.Layer.Equals(target.Layer, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("삭제 대상 객체의 레이어가 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
        }

        return entity;
    }
}
