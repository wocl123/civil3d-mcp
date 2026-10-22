using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;
using Table = Autodesk.AutoCAD.DatabaseServices.Table;

namespace MyCivil3DMcp.Plugin;

internal static class CivilQuantityTables
{
    private const string Key = "MYC3D_QUANTITY_SOURCE_V1";
    private static JsonObject Metadata(Transaction tr, Table table)
    {
        if (table.ExtensionDictionary.IsNull) throw new ArgumentException("이 도구로 만든 수량표가 아닙니다.");
        var dictionary = (DBDictionary)tr.GetObject(table.ExtensionDictionary, OpenMode.ForRead);
        if (!dictionary.Contains(Key)) throw new ArgumentException("수량표 원본 연결 정보가 없습니다.");
        var record = (Xrecord)tr.GetObject(dictionary.GetAt(Key), OpenMode.ForRead);
        using ResultBuffer? data = record.Data;
        return JsonNode.Parse(string.Concat(data?.AsArray().Select(v => v.Value.ToString()) ?? Array.Empty<string>()))?.AsObject() ?? throw new ArgumentException("원본 연결 정보가 잘못됐습니다.");
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        bool refresh = CivilObjectAccess.Text(r, "operation") == "quantityTable.refresh";
        if (refresh)
        {
            var t = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "table")) as Table ?? throw new ArgumentException("수량표 핸들을 지정하세요."); PrimitiveAccess.Writable(db, tr, t);
            JsonObject metadata = Metadata(tr, t); r["handles"] = metadata["handles"]!.DeepClone(); r["metric"] = metadata["metric"]!.DeepClone(); r["metadataState"] = metadata;
            if (t.Rows.Count > 203 || t.Columns.Count != 4) throw new ArgumentException("표의 행·열 구조가 변경돼 자동 갱신할 수 없습니다.");
            r["tableState"] = new JsonArray(Enumerable.Range(0, t.Rows.Count).Select(i => (JsonNode)new JsonArray(Enumerable.Range(0, 4).Select(j => JsonValue.Create(t.Cells[i, j].TextString)).ToArray())).ToArray());
        }
        else
        {
            PrimitiveAccess.Point(r["position"]); PrimitiveAccess.Layer(db, tr, r);
            foreach (string field in new[] { "rowHeight", "columnWidth", "height" }) if (CivilObjectAccess.Number(r[field]) <= 0) throw new ArgumentException("표 치수는 양수입니다.");
        }
        if (r["handles"] is not JsonArray handles || handles.Count is < 1 or > 200) throw new ArgumentException("실제 원본 객체 1~200개를 지정하세요.");
        string metric = CivilObjectAccess.Text(r, "metric"); if (metric is not ("length" or "count" or "area")) throw new ArgumentException("length/count/area 항목을 지정하세요.");
        HashSet<ObjectId> ids = new(); JsonArray state = new(), rows = new(new JsonArray("객체", "종류", "수량", metric == "count" ? "개" : "도면 단위")); double total = 0;
        foreach (JsonNode? h in handles)
        {
            var e = CivilObjectAccess.ByHandle(tr, db, h!.ToString()); if (!ids.Add(e.ObjectId)) throw new ArgumentException("원본이 중복됩니다.");
            string name = e is Autodesk.Civil.DatabaseServices.Entity civil ? civil.Name : e.Handle.ToString();
            double value;
            if (metric == "count") value = 1;
            else if (metric == "length") value = e switch {
                Pipe p => p.Length3DCenterToCenter, PressurePipe p => p.Length3DCenterToCenter,
                Line l => l.Length, Arc a => a.Length, Polyline p => p.Length,
                FeatureLine f => f.Length3D, Alignment a => a.Length,
                _ => throw new ArgumentException("지원하지 않는 길이 측정 객체입니다.") };
            else if (e is Polyline p && p.Closed) value = p.Area;
            else if (e is Catchment c)
            {
                var points = c.BoundaryPolyline3d; value = 0;
                for (int i = 0; i < points.Count; i++) { var a = points[i]; var b = points[(i + 1) % points.Count]; value += a.X * b.Y - a.Y * b.X; } value = Math.Abs(value) / 2;
            }
            else throw new ArgumentException("면적은 폐합 경량 폴리선 또는 집수구역의 XY 투영 면적만 지원합니다.");
            if (!double.IsFinite(value)) throw new ArgumentException("원본 수량이 유한하지 않습니다.");
            total += value; string units = metric switch { "count" => "개", "area" => "도면 단위²", _ => "도면 단위" };
            rows.Add(new JsonArray(name, e.GetType().Name, value.ToString("0.########", CultureInfo.InvariantCulture), units));
            state.Add(new JsonObject { ["handle"] = e.Handle.ToString(), ["name"] = name, ["type"] = e.GetType().Name, ["value"] = value });
        }
        rows.Add(new JsonArray("합계", "", total.ToString("0.########", CultureInfo.InvariantCulture), ""));
        r["sourceState"] = state; r["computedRows"] = rows;
        details.Add($"실제 객체 {ids.Count}개 {metric}, 합계 {total:0.########}. 도면 단위를 그대로 사용하며 수동 갱신형 수량표입니다.");
        details.Add("원본 핸들을 표에 저장합니다. 객체 변경 후 quantityTable.refresh로 갱신하며 실시간 자동 갱신·재료별 토공량표와 구별합니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return refresh ? "객체 기반 수량표 갱신" : "객체 기반 수량표 생성";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        bool refresh = CivilObjectAccess.Text(r, "operation") == "quantityTable.refresh";
        Table table;
        if (refresh) { table = (Table)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "table")); table.UpgradeOpen(); }
        else table = new Table { TableStyle = db.Tablestyle, Position = PrimitiveAccess.Point(r["position"]) };
        var rows = (JsonArray)r["computedRows"]!;
        table.SetSize(rows.Count, 4);
        if (!refresh) { table.SetRowHeight(CivilObjectAccess.Number(r["rowHeight"])); table.SetColumnWidth(CivilObjectAccess.Number(r["columnWidth"])); }
        for (int i = 0; i < rows.Count; i++) for (int j = 0; j < 4; j++)
        {
            table.Cells[i, j].TextString = rows[i]![j]!.ToString();
            if (!refresh) table.Cells[i, j].TextHeight = CivilObjectAccess.Number(r["height"]);
        }
        table.GenerateLayout();
        if (!refresh) { table.LayerId = PrimitiveAccess.Layer(db, tr, r); PrimitiveAccess.Append(db, tr, table); }
        if (table.ExtensionDictionary.IsNull) table.CreateExtensionDictionary();
        var dictionary = (DBDictionary)tr.GetObject(table.ExtensionDictionary, OpenMode.ForWrite);
        Xrecord record;
        if (dictionary.Contains(Key)) record = (Xrecord)tr.GetObject(dictionary.GetAt(Key), OpenMode.ForWrite);
        else { record = new Xrecord(); dictionary.SetAt(Key, record); tr.AddNewlyCreatedDBObject(record, true); }
        string json = new JsonObject { ["handles"] = r["handles"]!.DeepClone(), ["metric"] = r["metric"]!.DeepClone() }.ToJsonString();
        record.Data = new ResultBuffer(Enumerable.Range(0, (json.Length + 249) / 250).Select(i => new TypedValue((int)DxfCode.Text, json.Substring(i * 250, Math.Min(250, json.Length - i * 250)))).ToArray());
        return new { handle = table.Handle.ToString(), rows = rows.Count, automaticRefresh = false };
    }
}
