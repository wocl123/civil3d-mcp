using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Microsoft.VisualBasic.FileIO;

namespace MyCivil3DMcp.Plugin;

internal static class PointFileImport
{
    private static JsonObject Request(JsonObject r)
    {
        JsonObject q = (JsonObject)r.DeepClone(); q["operation"] = "cogo.create"; return q;
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        r["fileDigest"] = SurfaceExtensions.FileDigest(r, "path", ".csv");
        using TextFieldParser parser = new(CivilObjectAccess.Text(r, "path"), System.Text.Encoding.UTF8, true) {
            TextFieldType = FieldType.Delimited, HasFieldsEnclosedInQuotes = true, TrimWhiteSpace = false };
        parser.SetDelimiters(",");
        string[] header = parser.ReadFields() ?? throw new ArgumentException("빈 CSV 파일입니다.");
        if (!header.Select(s => s.Trim().ToLowerInvariant()).SequenceEqual(new[] { "number", "x", "y", "z", "description" }))
            throw new ArgumentException("UTF-8 CSV의 첫 줄은 number,x,y,z,description이어야 합니다. 좌표는 WCS 도면 단위입니다.");
        JsonArray points = new();
        while (!parser.EndOfData)
        {
            string[] row = parser.ReadFields() ?? throw new ArgumentException("CSV 행을 읽을 수 없습니다.");
            if (row.Length != 5 || !uint.TryParse(row[0], NumberStyles.None, CultureInfo.InvariantCulture, out uint number)) throw new ArgumentException("CSV 행은 점번호, X, Y, Z, 설명 5개 필드여야 합니다.");
            double N(string s) => double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out double v) && double.IsFinite(v) ? v : throw new ArgumentException("CSV 좌표는 유한한 숫자이며 소수점은 '.'입니다.");
            points.Add(new JsonObject { ["number"] = number, ["position"] = new JsonObject { ["x"] = N(row[1]), ["y"] = N(row[2]), ["z"] = N(row[3]) }, ["rawDescription"] = row[4] });
            if (points.Count > 1000) throw new ArgumentException("한 번에 1000개 이하의 COGO 점만 가져옵니다.");
        }
        r["points"] = points;
        JsonObject q = Request(r);
        string summary = CogoChanges.Validate(db, tr, q, details);
        foreach (string key in new[] { "layer", "style", "labelStyle" }) if (q[key] is not null) r[key] = q[key]!.DeepClone();
        details.Add($"입력 파일: {r["path"]}. 점번호 충돌 시 전체 작업을 거절하며 좌표계를 자동 변환하지 않습니다.");
        return "CSV " + summary;
    }
    public static object Apply(Database db, Transaction tr, JsonObject r) => CogoChanges.Apply(db, tr, Request(r));
}
