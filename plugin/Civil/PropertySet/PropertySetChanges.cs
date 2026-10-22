using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Aec.PropertyData.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class PropertySetChanges
{
    private static string? Unit(PropertyDefinition property)
    {
        try { return property.UnitType.ToString(); }
        catch (Autodesk.AutoCAD.Runtime.Exception ex) when (ex.ErrorStatus == Autodesk.AutoCAD.Runtime.ErrorStatus.NotApplicable) { return null; }
    }
    private static PropertySetDefinition Definition(Database db, Transaction tr, string key)
    {
        var dictionary = new DictionaryPropertySetDefinitions(db);
        var ids = dictionary.Records.Cast<ObjectId>().ToArray();
        var matches = ids.Where(id => id.Handle.ToString().Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length == 0) matches = ids.Where(id => dictionary.NameAt(id).Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        return matches.Length == 1 ? (PropertySetDefinition)tr.GetObject(matches[0], OpenMode.ForRead) : throw new ArgumentException("속성 세트 정의가 없거나 이름이 중복됩니다.");
    }
    private static JsonNode? Value(object? value) => value switch {
        null => null, string s => JsonValue.Create(s), bool b => JsonValue.Create(b), int i => JsonValue.Create(i),
        short s => JsonValue.Create(s), double d when double.IsFinite(d) => JsonValue.Create(d),
        _ => JsonValue.Create(Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture)) };
    internal static JsonObject Schema(Database db, PropertySetDefinition d) => new() {
        ["name"] = new DictionaryPropertySetDefinitions(db).NameAt(d.ObjectId), ["handle"] = d.Handle.ToString(),
        ["styleBased"] = d.IsStyleBased, ["filter"] = new JsonArray(d.AppliesToFilter.Cast<string>().Select(v => JsonValue.Create(v)).ToArray()),
        ["properties"] = new JsonArray(d.Definitions.Cast<PropertyDefinition>().Select(p => (JsonNode)new JsonObject {
            ["id"] = p.Id, ["name"] = p.Name, ["type"] = p.DataType.ToString(), ["automatic"] = p.Automatic,
            ["readOnly"] = p.IsReadOnly, ["locked"] = p.IsLocked, ["unit"] = Unit(p) }).ToArray()) };
    private static JsonArray Sets(Transaction tr, DBObject entity) => new(PropertyDataServices.GetPropertySets(entity).Cast<ObjectId>().Select(id => {
        var set = (PropertySet)tr.GetObject(id, OpenMode.ForRead); var d = (PropertySetDefinition)tr.GetObject(set.PropertySetDefinition, OpenMode.ForRead);
        return (JsonNode)new JsonObject { ["handle"] = set.Handle.ToString(), ["definition"] = d.Handle.ToString(), ["name"] = set.PropertySetDefinitionName,
            ["values"] = new JsonArray(d.Definitions.Cast<PropertyDefinition>().Select(p => (JsonNode)new JsonObject { ["id"] = p.Id,
                ["name"] = p.Name, ["automatic"] = p.Automatic, ["value"] = Value(set.GetAt(p.Id)) }).ToArray()) };
    }).ToArray());
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        if (r["handle"] is not null)
        {
            var e = CivilObjectAccess.ByHandle(tr, doc.Database, CivilObjectAccess.Text(r, "handle"));
            return new { handle = e.Handle.ToString(), sets = Sets(tr, e) };
        }
        ObjectId[] ids = new DictionaryPropertySetDefinitions(doc.Database).Records.Cast<ObjectId>().ToArray();
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        return new { total = ids.Length, offset, items = ids.Skip(offset).Take(limit).Select(id => Schema(doc.Database, (PropertySetDefinition)tr.GetObject(id, OpenMode.ForRead))).ToArray(), hasMore = offset + limit < ids.Length };
    }
    private static object Typed(PropertyDefinition p, JsonNode? value)
    {
        if (p.Automatic || p.IsReadOnly || p.IsLocked) throw new ArgumentException("자동·잠김·읽기 전용 속성은 수정하지 않습니다.");
        return p.DataType.ToString() switch {
            "Text" => value?.GetValue<string>() ?? throw new ArgumentException("문자열 값이 필요합니다."),
            "Integer" => value!.GetValue<int>(), "Real" => CivilObjectAccess.Number(value), "TrueFalse" => value!.GetValue<bool>(),
            _ => throw new ArgumentException("이 도구는 Text/Integer/Real/TrueFalse 수동 속성만 편집합니다.") };
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        var d = Definition(db, tr, CivilObjectAccess.Text(r, "definition")); r["definition"] = d.Handle.ToString(); r["definitionState"] = Schema(db, d);
        if (d.IsStyleBased) throw new ArgumentException("스타일 기반 속성 세트는 이 도구로 변경하지 않습니다.");
        if (r["handles"] is not JsonArray handles || handles.Count is < 1 or > 200) throw new ArgumentException("대상 1~200개를 지정하세요.");
        string action = CivilObjectAccess.Text(r, "action"); if (action is not ("attach" or "detach" or "set")) throw new ArgumentException("attach/detach/set 작업을 지정하세요.");
        if (action == "set")
        {
            if (r["values"] is not JsonObject values || values.Count is < 1 or > 100) throw new ArgumentException("수동 속성 이름과 값 1~100개를 지정하세요.");
            foreach (var pair in values)
            {
                var p = d.Definitions.Cast<PropertyDefinition>().SingleOrDefault(p => p.Name == pair.Key) ?? throw new ArgumentException("정의에 없는 속성 이름입니다.");
                Typed(p, pair.Value);
            }
        }
        JsonArray state = new(); HashSet<ObjectId> seen = new();
        foreach (JsonNode? h in handles)
        {
            var e = CivilObjectAccess.ByHandle(tr, db, h!.ToString()); PrimitiveAccess.Writable(db, tr, e);
            if (e is Autodesk.Civil.DatabaseServices.Entity civil) CivilObjectAccess.Editable(civil);
            if (!seen.Add(e.ObjectId)) throw new ArgumentException("대상 핸들이 중복됩니다.");
            JsonArray sets = Sets(tr, e); bool present = sets.Any(s => s!["definition"]!.ToString() == d.Handle.ToString());
            if ((action == "attach" && present) || (action != "attach" && !present)) throw new ArgumentException("속성 세트 부착 상태가 요청과 다릅니다.");
            state.Add(new JsonObject { ["handle"] = e.Handle.ToString(), ["sets"] = sets });
        }
        r["sourceState"] = state;
        details.Add($"{new DictionaryPropertySetDefinitions(db).NameAt(d.ObjectId)}: {handles.Count}개 객체 {action}. 단위는 정의의 API 단위를 따르며 자동 변환하지 않습니다.");
        if (action == "detach") details.Add("분리하면 해당 객체의 수동 속성값이 삭제됩니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return "속성 세트 부착·분리·수동값 편집";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var d = Definition(db, tr, CivilObjectAccess.Text(r, "definition")); string action = CivilObjectAccess.Text(r, "action");
        foreach (JsonNode? h in (JsonArray)r["handles"]!)
        {
            var e = CivilObjectAccess.ByHandle(tr, db, h!.ToString()); e.UpgradeOpen();
            if (action == "attach") PropertyDataServices.AddPropertySet(e, d.ObjectId);
            else if (action == "detach") PropertyDataServices.RemovePropertySet(e, d.ObjectId);
            else
            {
                var set = (PropertySet)tr.GetObject(PropertyDataServices.GetPropertySet(e, d.ObjectId), OpenMode.ForWrite);
                foreach (var pair in (JsonObject)r["values"]!)
                {
                    var p = d.Definitions.Cast<PropertyDefinition>().Single(p => p.Name == pair.Key); set.SetAt(p.Id, Typed(p, pair.Value));
                }
            }
        }
        return new { affected = r["handles"]!.DeepClone(), action };
    }
}
