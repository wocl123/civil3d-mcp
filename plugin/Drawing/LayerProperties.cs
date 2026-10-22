using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class LayerProperties
{
    private static LayerTableRecord Find(Database db, Transaction tr, JsonObject r)
    {
        LayerTable layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
        string name = CivilObjectAccess.Text(r, "layer");
        if (!layers.Has(name)) throw new ArgumentException("레이어가 없습니다.");
        return (LayerTableRecord)tr.GetObject(layers[name], OpenMode.ForRead);
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        LayerTableRecord layer = Find(db, tr, r);
        if (layer.IsDependent) throw new ArgumentException("외부참조 레이어는 변경하지 않습니다.");
        if (!new[] { "newName", "linetype", "lineweight", "transparency", "plottable" }.Any(k => r[k] is not null)) throw new ArgumentException("변경할 레이어 속성을 지정하세요.");
        if (r["newName"] is not null)
        {
            if (layer.Name.Equals("0", StringComparison.OrdinalIgnoreCase) || layer.Name.Equals("Defpoints", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("예약 레이어의 이름은 변경하지 않습니다.");
            string name = CivilObjectAccess.Text(r, "newName"); SymbolUtilityServices.ValidateSymbolName(name, false);
            if (((LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead)).Has(name)) throw new ArgumentException("같은 레이어 이름이 이미 있습니다.");
        }
        if (r["linetype"] is not null)
        {
            var types = (LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead);
            string type = CivilObjectAccess.Text(r, "linetype");
            if (!types.Has(type) || type.Equals("ByLayer", StringComparison.OrdinalIgnoreCase) || type.Equals("ByBlock", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("이미 로드된 명시적인 선종류를 지정하세요.");
        }
        if (r["lineweight"] is not null)
        {
            int weight = r["lineweight"]!.GetValue<int>();
            if (weight < -3 || weight > 211 || !Enum.IsDefined((LineWeight)weight) || weight is -1 or -2) throw new ArgumentException("선가중치는 유효한 1/100mm 정수(예: 25=0.25mm) 또는 -3(Default)입니다.");
        }
        if (r["transparency"] is not null && CivilObjectAccess.Number(r["transparency"]) is < 0 or > 90) throw new ArgumentException("투명도는 0~90%입니다.");
        r["sourceState"] = JsonSerializer.SerializeToNode(new { layer.Name, layer.IsPlottable, layer.LineWeight,
            linetype = layer.LinetypeObjectId.Handle.ToString(), alpha = layer.Transparency.IsByAlpha ? (int?)layer.Transparency.Alpha : null,
            byLayer = layer.Transparency.IsByLayer, byBlock = layer.Transparency.IsByBlock });
        details.Add($"레이어 {layer.Name} [{layer.Handle}] 속성 수정. ByLayer 객체의 표시가 함께 바뀝니다.");
        details.AddRange(CivilPlanDetails.Describe(r));
        return "레이어 세부 속성 수정";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var layer = Find(db, tr, r); layer.UpgradeOpen();
        if (r["newName"] is not null) layer.Name = CivilObjectAccess.Text(r, "newName");
        if (r["linetype"] is not null) layer.LinetypeObjectId = ((LinetypeTable)tr.GetObject(db.LinetypeTableId, OpenMode.ForRead))[CivilObjectAccess.Text(r, "linetype")];
        if (r["lineweight"] is not null) layer.LineWeight = (LineWeight)r["lineweight"]!.GetValue<int>();
        if (r["transparency"] is not null) layer.Transparency = new Transparency((byte)Math.Round(255 * (1 - CivilObjectAccess.Number(r["transparency"]) / 100)));
        if (r["plottable"] is not null) layer.IsPlottable = r["plottable"]!.GetValue<bool>();
        return new { name = layer.Name, handle = layer.Handle.ToString() };
    }
}
