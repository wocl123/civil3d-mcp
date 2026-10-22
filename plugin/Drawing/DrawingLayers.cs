using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

// 레이어 생성·상태 변경·삭제. 미리 보기는 읽기만 하고, 적용은 Undo 한 번으로 묶는다.
internal static class DrawingLayers
{
    public sealed record Definition(string Name, short Color, bool Locked, bool Frozen, bool Off);
    public sealed record Target(string Name, string Handle, IReadOnlyList<LayerObjects.Target>? Objects);
    public sealed record Edit(string Name, string Handle, LayerState Before, LayerState After, bool ChangeColor);
    public sealed record PreviewItem(string Name, string? Handle, LayerState? Before, LayerState? After,
        IReadOnlyList<LayerObjects.Target> Objects, IReadOnlyList<string> Effects, string? Blocked,
        bool ChangeColor = false);
    public sealed record PreviewResult(IReadOnlyList<PreviewItem> Items);
    public sealed record Result(IReadOnlyList<string> CreatedLayers, IReadOnlyList<string> DeletedLayers,
        IReadOnlyList<string>? EditedLayers = null, int DeletedObjects = 0);

    private static readonly JsonSerializerOptions ReadOptions = new() { PropertyNameCaseInsensitive = true };

    public static PreviewResult Preview(Document document, JsonObject? parameters)
    {
        string action = ReadAction(parameters);
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();
        LayerTable table = (LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForRead);
        if (action == "create")
        {
            return PreviewCreate(table, ReadDefinitions(parameters));
        }

        List<string> names = ReadNames(parameters);
        if (action == "edit")
        {
            return PreviewEdit(database, transaction, table, names, parameters);
        }

        bool deleteObjects = parameters?["deleteObjects"]?.GetValue<bool>() == true;
        return PreviewDelete(database, transaction, table, names, deleteObjects);
    }

    private static PreviewResult PreviewCreate(LayerTable table, IReadOnlyList<Definition> definitions)
    {
        List<PreviewItem> items = new();
        foreach (Definition layer in definitions)
        {
            LayerState state = new(layer.Color, layer.Locked, layer.Frozen, layer.Off);
            items.Add(new PreviewItem(layer.Name, null, null, state, [], [], CreationBlock(table, layer)));
        }

        return new PreviewResult(items);
    }

    private static PreviewResult PreviewDelete(Database database, Transaction transaction, LayerTable table,
        IReadOnlyList<string> names, bool deleteObjects)
    {
        Dictionary<string, LayerObjects.Inventory> inventory = LayerObjects.Read(database, transaction, names);
        List<PreviewItem> items = new();
        foreach (string name in names)
        {
            if (!table.Has(name))
            {
                items.Add(new PreviewItem(name, null, null, null, [], [], "도면에 없는 레이어입니다."));
                continue;
            }

            LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(table[name], OpenMode.ForRead);
            LayerObjects.Inventory objects = inventory[name];
            string? blocked = DeletionBlock(database, layer, objects, deleteObjects);
            items.Add(new PreviewItem(layer.Name, layer.Handle.ToString(), LayerState.Read(layer), null,
                objects.Objects, objects.Effects, blocked));
        }

        return new PreviewResult(items);
    }

    private static PreviewResult PreviewEdit(Database database, Transaction transaction, LayerTable table,
        IReadOnlyList<string> names, JsonObject? parameters)
    {
        short? color = parameters?["color"]?.GetValue<short>();
        bool? locked = parameters?["locked"]?.GetValue<bool>();
        bool? frozen = parameters?["frozen"]?.GetValue<bool>();
        bool? off = parameters?["off"]?.GetValue<bool>();
        bool empty = color is null && locked is null && frozen is null && off is null;
        if (empty || color is < 1 or > 255)
        {
            throw new ArgumentException("바꿀 레이어 속성(색상 1~255, 잠금, 동결, 켜짐/꺼짐)을 지정하세요.");
        }

        List<PreviewItem> items = new();
        foreach (string name in names)
        {
            if (!table.Has(name))
            {
                items.Add(new PreviewItem(name, null, null, null, [], [], "도면에 없는 레이어입니다."));
                continue;
            }

            LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(table[name], OpenMode.ForRead);
            LayerState before = LayerState.Read(layer);
            LayerState after = new(
                color ?? before.Color, locked ?? before.Locked, frozen ?? before.Frozen, off ?? before.Off);
            string? blocked = StateBlock(database, layer, after);
            items.Add(new PreviewItem(
                layer.Name, layer.Handle.ToString(), before, after, [], [], blocked, color.HasValue));
        }

        return new PreviewResult(items);
    }

    // 적용 전에 전체 대상을 다시 검사한다. 하나라도 달라졌으면 트랜잭션을 커밋하지 않는다.
    public static Result Apply(Document document, JsonObject? parameters)
    {
        string action = ReadAction(parameters);
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();
        LayerTable table = (LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForRead);

        Result result = action switch
        {
            "create" => Create(transaction, table, ReadDefinitions(parameters)),
            "edit" => ApplyEdits(database, transaction, table, ReadList<Edit>(parameters, "edits")),
            _ => Delete(database, transaction, table, ReadTargets(parameters),
                parameters?["deleteObjects"]?.GetValue<bool>() == true)
        };
        transaction.Commit();
        return result;
    }

    private static Result Create(Transaction transaction, LayerTable table, IReadOnlyList<Definition> definitions)
    {
        foreach (Definition definition in definitions)
        {
            string? blocked = CreationBlock(table, definition);
            if (blocked is not null)
            {
                throw new ArgumentException($"레이어 {definition.Name}: {blocked}");
            }
        }

        table = (LayerTable)transaction.GetObject(table.ObjectId, OpenMode.ForWrite);
        foreach (Definition definition in definitions)
        {
            using LayerTableRecord layer = new() { Name = definition.Name };
            new LayerState(definition.Color, definition.Locked, definition.Frozen, definition.Off).Apply(layer);
            table.Add(layer);
            transaction.AddNewlyCreatedDBObject(layer, true);
        }

        return new Result(definitions.Select(layer => layer.Name).ToArray(), []);
    }

    private static Result Delete(Database database, Transaction transaction, LayerTable table,
        IReadOnlyList<Target> targets, bool deleteObjects)
    {
        List<LayerTableRecord> layers = DeletableLayers(database, transaction, table, targets, deleteObjects);
        LayerObjects.Target[] objects = targets.SelectMany(target => target.Objects ?? [])
            .DistinctBy(target => target.Handle).ToArray();
        HashSet<string> expected = objects.Select(target => target.Handle)
            .Concat(targets.Select(target => target.Handle)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        using DrawingRevisions.Recorder journal = DrawingRevisions.Record(database);
        LayerObjects.Erase(database, transaction, objects);
        foreach (LayerTableRecord layer in layers)
        {
            if (!Unused(database, layer))
            {
                throw new ArgumentException($"레이어 {layer.Name}은(는) 도면 설정에서 사용 중입니다. 전체 삭제를 취소합니다.");
            }

            LayerTableRecord writable = (LayerTableRecord)transaction.GetObject(layer.ObjectId, OpenMode.ForWrite);
            writable.Erase();
        }

        bool unexpected = journal.Overflowed || journal.Changes.Any(change =>
            change.Counted && change.Event == "삭제" && !expected.Contains(change.Handle));
        if (unexpected)
        {
            throw new ArgumentException("계획에 없는 연관 객체가 함께 삭제되어 전체 작업을 취소했습니다. 다시 확인하세요.");
        }

        return new Result([], targets.Select(target => target.Name).ToArray(), DeletedObjects: objects.Length);
    }

    private static List<LayerTableRecord> DeletableLayers(Database database, Transaction transaction, LayerTable table,
        IReadOnlyList<Target> targets, bool deleteObjects)
    {
        Dictionary<string, LayerObjects.Inventory> inventory =
            LayerObjects.Read(database, transaction, targets.Select(target => target.Name));
        List<LayerTableRecord> layers = new();
        foreach (Target target in targets)
        {
            LayerTableRecord layer = PlannedLayer(transaction, table, target.Name, target.Handle);
            LayerObjects.Inventory current = inventory[target.Name];
            string? blocked = DeletionBlock(database, layer, current, deleteObjects);
            if (blocked is not null)
            {
                throw new ArgumentException($"레이어 {target.Name}: {blocked}");
            }

            HashSet<LayerObjects.Target> planned = (target.Objects ?? []).ToHashSet();
            if (!planned.SetEquals(current.Objects))
            {
                throw new ArgumentException("삭제 대상 객체가 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
            }

            layers.Add(layer);
        }

        return layers;
    }

    private static string? CreationBlock(LayerTable table, Definition definition)
    {
        try
        {
            ValidateName(definition.Name, false);
        }
        catch (ArgumentException ex)
        {
            return ex.Message;
        }

        if (table.Has(definition.Name))
        {
            return "이미 있는 레이어입니다. 기존 속성은 바꾸지 않습니다.";
        }

        return null;
    }

    private static string? DeletionBlock(Database database, LayerTableRecord layer,
        LayerObjects.Inventory inventory, bool deleteObjects)
    {
        bool reserved = layer.Name.Equals("0", StringComparison.OrdinalIgnoreCase)
            || layer.Name.Equals("Defpoints", StringComparison.OrdinalIgnoreCase);
        if (reserved)
        {
            return "기본 레이어는 삭제할 수 없습니다.";
        }

        if (layer.ObjectId == database.Clayer)
        {
            return "현재 레이어는 삭제할 수 없습니다. 다른 레이어를 현재 레이어로 지정하세요.";
        }

        if (layer.IsDependent)
        {
            return "외부참조 레이어는 삭제할 수 없습니다.";
        }

        if (inventory.Objects.Count > 0)
        {
            return deleteObjects ? inventory.Blocked : "객체가 있는 레이어입니다. 객체도 함께 삭제할지 사용자에게 질문하세요.";
        }

        return Unused(database, layer) ? null : "도면 설정에서 사용 중인 레이어입니다.";
    }

    private static bool Unused(Database database, LayerTableRecord layer)
    {
        ObjectIdCollection ids = new([layer.ObjectId]);
        database.Purge(ids);
        return ids.Count > 0;
    }

    private static string? StateBlock(Database database, LayerTableRecord layer, LayerState after)
    {
        if (layer.IsDependent)
        {
            return "외부참조 레이어의 속성은 바꾸지 않습니다.";
        }

        return after.Frozen && layer.ObjectId == database.Clayer ? "현재 레이어는 동결할 수 없습니다." : null;
    }

    private static LayerTableRecord PlannedLayer(Transaction transaction, LayerTable table, string name, string handle)
    {
        ValidateName(name, true);
        if (!table.Has(name))
        {
            throw new ArgumentException($"레이어 {name}이(가) 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
        }

        LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(table[name], OpenMode.ForRead);
        if (!layer.Handle.ToString().Equals(handle, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException($"레이어 {name}이(가) 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
        }

        return layer;
    }

    private static Result ApplyEdits(Database database, Transaction transaction, LayerTable table,
        IReadOnlyList<Edit> edits)
    {
        List<(Edit Edit, LayerTableRecord Layer)> found = ValidateEdits(database, transaction, table, edits);
        foreach ((Edit edit, LayerTableRecord layer) in found)
        {
            LayerTableRecord writable = (LayerTableRecord)transaction.GetObject(layer.ObjectId, OpenMode.ForWrite);
            edit.After.Apply(writable, edit.ChangeColor);
        }

        return new Result([], [], edits.Select(edit => edit.Name).ToArray());
    }

    private static List<(Edit, LayerTableRecord)> ValidateEdits(Database database, Transaction transaction,
        LayerTable table, IReadOnlyList<Edit> edits)
    {
        EnsureUnique(edits.Select(edit => edit.Name));
        List<(Edit Edit, LayerTableRecord Layer)> found = new();
        foreach (Edit edit in edits)
        {
            if (edit.Before is null || edit.After is null)
            {
                throw new ArgumentException("레이어 상태 변경 계획이 올바르지 않습니다. 다시 계획하세요.");
            }

            LayerTableRecord layer = PlannedLayer(transaction, table, edit.Name, edit.Handle);
            if (LayerState.Read(layer) != edit.Before)
            {
                throw new ArgumentException("레이어가 계획 뒤에 바뀌었습니다. 다시 계획하세요.");
            }

            string? blocked = StateBlock(database, layer, edit.After);
            bool invalidColor = edit.ChangeColor && edit.After.Color is < 1 or > 255;
            if (blocked is not null || invalidColor)
            {
                throw new ArgumentException(blocked ?? "레이어 색상은 1~255여야 합니다.");
            }

            found.Add((edit, layer));
        }

        return found;
    }

    private static string ReadAction(JsonObject? parameters)
    {
        string? action = parameters?["action"]?.ToString();
        if (action is not ("create" or "delete" or "edit"))
        {
            throw new ArgumentException("레이어 작업은 create, edit 또는 delete여야 합니다.");
        }

        return action;
    }

    private static List<Definition> ReadDefinitions(JsonObject? parameters)
    {
        List<Definition> layers = ReadList<Definition>(parameters, "create");
        EnsureUnique(layers.Select(layer => layer.Name));
        foreach (Definition layer in layers)
        {
            if (layer.Color is < 1 or > 255)
            {
                throw new ArgumentException("레이어 색상은 ACI 1~255여야 합니다.");
            }
        }

        return layers;
    }

    private static List<string> ReadNames(JsonObject? parameters)
    {
        List<string> names = ReadList<string>(parameters, "names");
        EnsureUnique(names);
        foreach (string name in names)
        {
            ValidateName(name, true);
        }

        return names;
    }

    private static List<Target> ReadTargets(JsonObject? parameters)
    {
        List<Target> targets = ReadList<Target>(parameters, "targets");
        EnsureUnique(targets.Select(target => target.Name));
        foreach (Target target in targets)
        {
            ValidateName(target.Name, true);
            bool validHandle = target.Handle is not null && target.Handle.Length is >= 1 and <= 16
                && long.TryParse(target.Handle, System.Globalization.NumberStyles.HexNumber, null, out _);
            if (!validHandle)
            {
                throw new ArgumentException("레이어 핸들이 올바르지 않습니다.");
            }
        }

        return targets;
    }

    private static List<T> ReadList<T>(JsonObject? parameters, string key) where T : class
    {
        JsonArray? array = parameters?[key] as JsonArray;
        if (array is null || array.Count is < 1 or > 100)
        {
            throw new ArgumentException("레이어는 1~100개를 지정하세요.");
        }

        List<T>? items = array.Deserialize<List<T>>(ReadOptions);
        if (items is null || items.Any(item => item is null))
        {
            throw new ArgumentException("레이어 입력이 올바르지 않습니다.");
        }

        return items;
    }

    private static void EnsureUnique(IEnumerable<string> names)
    {
        HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);
        foreach (string name in names)
        {
            if (!seen.Add(name))
            {
                throw new ArgumentException("같은 레이어를 두 번 지정할 수 없습니다.");
            }
        }
    }

    private static void ValidateName(string name, bool allowReference)
    {
        bool invalid = string.IsNullOrWhiteSpace(name) || name.Length > 255 || name != name.Trim();
        if (invalid)
        {
            throw new ArgumentException("레이어 이름은 앞뒤 공백 없이 1~255자로 지정하세요.");
        }

        try
        {
            SymbolUtilityServices.ValidateSymbolName(name, allowReference);
        }
        catch (Autodesk.AutoCAD.Runtime.Exception)
        {
            throw new ArgumentException("레이어 이름에 사용할 수 없는 문자가 있습니다.");
        }
    }
}
