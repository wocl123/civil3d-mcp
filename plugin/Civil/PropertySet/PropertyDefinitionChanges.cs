using System.Collections.Specialized;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Aec.PropertyData;
using Autodesk.Aec.PropertyData.DatabaseServices;
using DataType = Autodesk.Aec.PropertyData.DataType;

namespace MyCivil3DMcp.Plugin;

// Schema changes preserve existing property IDs and attached data. Never delete or change types.
internal static class PropertyDefinitionChanges
{
    private static PropertySetDefinition? Find(Database db, Transaction tr, string name) =>
        new DictionaryPropertySetDefinitions(db).Records.Cast<ObjectId>()
            .Select(id => (PropertySetDefinition)tr.GetObject(id, OpenMode.ForRead))
            .SingleOrDefault(d => new DictionaryPropertySetDefinitions(db).NameAt(d.ObjectId).Equals(name, StringComparison.OrdinalIgnoreCase));
    private static object Default(JsonObject field) => CivilObjectAccess.Text(field, "type") switch {
        "Text" => field["default"]?.GetValue<string>() ?? throw new ArgumentException("Text 기본값은 문자열이어야 합니다."),
        "Integer" => field["default"]!.GetValue<int>(), "Real" => CivilObjectAccess.Number(field["default"]),
        "TrueFalse" => field["default"]!.GetValue<bool>(), _ => throw new ArgumentException("Text/Integer/Real/TrueFalse 수동 속성만 지원합니다.") };
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string action = CivilObjectAccess.Text(r, "action"), name = CivilObjectAccess.Text(r, "name");
        SymbolUtilityServices.ValidateSymbolName(name, false);
        var d = Find(db, tr, name);
        if (action is not ("create" or "add") || (action == "create" ? d is not null : d is null)) throw new ArgumentException("create는 새 정의, add는 기존 정의 이름을 지정하세요.");
        if (d is not null && (d.IsStyleBased || !d.IsWriteable)) throw new ArgumentException("쓰기 가능한 객체 기반 정의만 확장할 수 있습니다.");
        if (action == "create")
        {
            if (r["appliesTo"] is not JsonArray filter || filter.Count is < 1 or > 50) throw new ArgumentException("실제 RX 클래스 이름 1~50개를 지정하세요.");
            foreach (JsonNode? node in filter)
            {
                string value = node!.GetValue<string>();
                if (string.IsNullOrWhiteSpace(value) || value.Length > 255 || !value.All(c => char.IsLetterOrDigit(c) || c == '_')) throw new ArgumentException("정확한 RX 클래스 이름을 지정하세요.");
            }
        }
        if (r["properties"] is not JsonArray properties || properties.Count is < 1 or > 100) throw new ArgumentException("추가할 수동 속성 1~100개를 지정하세요.");
        HashSet<string> names = new(d?.Definitions.Cast<PropertyDefinition>().Select(p => p.Name) ?? Array.Empty<string>(), StringComparer.OrdinalIgnoreCase);
        foreach (JsonObject field in properties.OfType<JsonObject>())
        {
            string key = CivilObjectAccess.Text(field, "name"); SymbolUtilityServices.ValidateSymbolName(key, false);
            if (!names.Add(key)) throw new ArgumentException("기존 또는 요청 속성 이름이 중복됩니다.");
            Default(field);
        }
        if (properties.Any(p => p is not JsonObject) || names.Count > 500) throw new ArgumentException("정의당 최대 500개 수동 속성을 지원합니다.");
        r["definitionState"] = d is null ? null : PropertySetChanges.Schema(db, d);
        JsonArray affected = new();
        if (d is not null)
        {
            ObjectId[] ids = PropertyDataServices.GetAllPropertySetsUsingDefinition(d.ObjectId, false).Cast<ObjectId>().ToArray();
            if (ids.Length > 200) throw new ArgumentException("정의 확장은 부착 객체 최대 200개까지 지원합니다.");
            foreach (ObjectId id in ids)
            {
                var set = (PropertySet)tr.GetObject(id, OpenMode.ForRead);
                var owner = tr.GetObject(set.ObjectAttachedTo, OpenMode.ForRead) as Entity ?? throw new ArgumentException("도면 객체에 부착된 정의만 확장할 수 있습니다."); PrimitiveAccess.Writable(db, tr, owner);
                if (owner is Autodesk.Civil.DatabaseServices.Entity civil) CivilObjectAccess.Editable(civil);
                affected.Add(owner.Handle.ToString());
            }
        }
        r["affected"] = affected;
        details.Add($"{name}: 수동 속성 {properties.Count}개 {(action == "create" ? "정의 생성" : "추가")}. 기존 속성 ID·형식·부착값은 유지합니다.");
        details.Add("기본값은 새 속성의 초기값입니다. 기존 수동값을 일괄 덮어쓰지 않습니다. 자동/수식/위치 속성 및 스키마 삭제는 지원하지 않습니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return "속성 세트 정의 자동 생성·확장";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string name = CivilObjectAccess.Text(r, "name"); var d = Find(db, tr, name);
        if (d is null)
        {
            d = new PropertySetDefinition(); d.SetToStandard(db); d.SubSetDatabaseDefaults(db);
            var filter = new StringCollection(); foreach (JsonNode? f in (JsonArray)r["appliesTo"]!) filter.Add(f!.GetValue<string>());
            d.SetAppliesToFilter(filter, false);
            new DictionaryPropertySetDefinitions(db).AddNewRecord(name, d); tr.AddNewlyCreatedDBObject(d, true);
        }
        else d.UpgradeOpen();
        foreach (JsonObject field in ((JsonArray)r["properties"]!).OfType<JsonObject>())
            d.Definitions.Add(new PropertyDefinition { Name = CivilObjectAccess.Text(field, "name"), DataType = Enum.Parse<DataType>(CivilObjectAccess.Text(field, "type")), DefaultData = Default(field) });
        d.RecordAsModified();
        foreach (ObjectId id in PropertyDataServices.GetAllPropertySetsUsingDefinition(d.ObjectId, false))
        {
            var set = (PropertySet)tr.GetObject(id, OpenMode.ForWrite);
            var owner = tr.GetObject(set.ObjectAttachedTo, OpenMode.ForWrite); set.Synchronize(d, owner);
        }
        return new { handle = d.Handle.ToString(), definition = PropertySetChanges.Schema(db, d) };
    }
}
