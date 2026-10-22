using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class PointMetadata
{
    private static PointDescriptionKeySet Set(Database db, Transaction tr, string key)
    {
        var sets = PointDescriptionKeySetCollection.GetPointDescriptionKeySets(db);
        ObjectId[] matches = sets.Cast<ObjectId>().Where(i => i.Handle.ToString().Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        ObjectId id = matches.Length == 1 ? matches[0] : sets.Contains(key) ? sets[key] : ObjectId.Null;
        return !id.IsNull ? (PointDescriptionKeySet)tr.GetObject(id, OpenMode.ForRead) : throw new ArgumentException("설명 키 세트가 없습니다.");
    }
    private static JsonObject KeyState(PointDescriptionKey k) => new() { ["handle"] = k.Handle.ToString(), ["code"] = k.Code,
        ["format"] = k.Format, ["style"] = !k.ApplyStyleId || k.StyleId.IsNull ? null : k.StyleId.Handle.ToString(), ["applyStyle"] = k.ApplyStyleId,
        ["labelStyle"] = !k.ApplyLabelStyleId || k.LabelStyleId.IsNull ? null : k.LabelStyleId.Handle.ToString(), ["applyLabel"] = k.ApplyLabelStyleId,
        ["layer"] = !k.ApplyLayerId || k.LayerId.IsNull ? null : k.LayerId.Handle.ToString(), ["applyLayer"] = k.ApplyLayerId };
    private static UDP FindUdp(Database db, JsonObject r)
    {
        var classes = CivilDocument.GetCivilDocument(db).PointUDPClassifications;
        string classification = CivilObjectAccess.Text(r, "classification"), name = CivilObjectAccess.Text(r, "name");
        if (!classes.Contains(classification)) throw new ArgumentException("점 UDP 분류가 없습니다.");
        var all = classes[classification].UDPs.Where(u => u.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToArray();
        return all.Length == 1 ? all[0] : throw new ArgumentException("점 UDP가 없거나 이름이 중복됩니다.");
    }
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        object[] all;
        if (r["kind"]?.ToString() == "descriptionKeys")
            all = PointDescriptionKeySetCollection.GetPointDescriptionKeySets(doc.Database).Cast<ObjectId>()
                .Select(i => (PointDescriptionKeySet)tr.GetObject(i, OpenMode.ForRead)).Select(s => (object)new { handle = s.Handle.ToString(),
                    keys = s.GetPointDescriptionKeyIds().Cast<ObjectId>().Select(i => KeyState((PointDescriptionKey)tr.GetObject(i, OpenMode.ForRead))).ToArray() }).ToArray();
        else all = CivilDocument.GetCivilDocument(doc.Database).PointUDPClassifications.Select(c => (object)new { classification = c.Name,
            properties = c.UDPs.Select(u => new { name = u.Name, type = u.GetType().Name, guid = u.Guid.ToString(), u.Description }).ToArray() }).ToArray();
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        return new { total = all.Length, offset, items = all.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < all.Length };
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "descriptionSet.create")
        {
            if (PointDescriptionKeySetCollection.GetPointDescriptionKeySets(db).Contains(CivilObjectAccess.Text(r, "name"))) throw new ArgumentException("설명 키 세트 이름이 이미 있습니다.");
        }
        else if (op == "descriptionKey.set")
        {
            var set = Set(db, tr, CivilObjectAccess.Text(r, "set")); r["set"] = set.Handle.ToString();
            string code = CivilObjectAccess.Text(r, "code");
            if (set.Contains(code)) r["sourceState"] = KeyState((PointDescriptionKey)tr.GetObject(set[code], OpenMode.ForRead));
            if (!new[] { "format", "style", "labelStyle", "layer" }.Any(k => r[k] is not null)) throw new ArgumentException("설명 키의 형식·스타일·레이어를 지정하세요.");
            if (r["style"] is not null) CivilObjectAccess.Style(tr, db, "point", r["style"]!.ToString());
            if (r["labelStyle"] is not null) CivilObjectAccess.Style(tr, db, "pointLabel", r["labelStyle"]!.ToString());
            if (r["layer"] is not null) PrimitiveAccess.Layer(db, tr, r);
            details.Add("키가 없으면 생성하고 있으면 지정한 속성만 수정합니다. 기존 점에 적용하는 작업은 별도입니다.");
        }
        else if (op == "pointUdp.create")
        {
            var classes = CivilDocument.GetCivilDocument(db).PointUDPClassifications;
            string classification = CivilObjectAccess.Text(r, "classification"), name = CivilObjectAccess.Text(r, "name");
            if (classes.Contains(classification) && classes[classification].UDPs.Any(u => u.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("UDP 이름이 이미 있습니다.");
            if (!new[] { "string", "double", "integer", "boolean" }.Contains(CivilObjectAccess.Text(r, "type"))) throw new ArgumentException("지원하지 않는 UDP 종류입니다.");
            details.Add("분류가 없으면 함께 생성합니다. 기본값·기존 점의 값을 변경하지 않습니다.");
        }
        else if (op is "cogo.descriptionKeys" or "cogo.udp")
        {
            var points = PrimitiveAccess.Targets<CogoPoint>(db, tr, r).Cast<CogoPoint>().ToArray();
            foreach (var p in points) if (p.IsLocked || p.IsSurveyPoint || p.IsProjectPoint || !p.IsMovable) throw new ArgumentException("잠금·측량·프로젝트 점은 수정하지 않습니다.");
            r["sourceState"] = new JsonArray(points.Select(p => (JsonNode)new JsonObject { ["handle"] = p.Handle.ToString(), ["description"] = p.RawDescription,
                ["style"] = p.StyleId.IsNull ? null : p.StyleId.Handle.ToString(), ["layer"] = p.Layer }).ToArray());
            if (op == "cogo.udp")
            {
                UDP u = FindUdp(db, r); Value(u, r["value"]);
                r["udpGuid"] = u.Guid.ToString();
                r["udpState"] = new JsonArray(points.Select(p => JsonValue.Create(ReadValue(p, u)?.ToString())).ToArray());
            }
            else details.Add("현재 설명 키 검색 순서로 다시 적용합니다. 점의 스타일·레이어·완전 설명·축척·회전이 바뀔 수 있습니다.");
        }
        else throw new ArgumentException("지원하지 않는 점 메타데이터 작업입니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return CivilPlanDetails.Title(op);
    }
    private static object Value(UDP u, JsonNode? value) => u switch {
        UDPString => value?.GetValue<string>() ?? throw new ArgumentException("문자 UDP 값이 필요합니다."),
        UDPDouble => CivilObjectAccess.Number(value), UDPInteger => value?.GetValue<int>() ?? throw new ArgumentException("정수 UDP 값이 필요합니다."),
        UDPBoolean => value?.GetValue<bool>() ?? throw new ArgumentException("참/거짓 UDP 값이 필요합니다."),
        _ => throw new ArgumentException("이 UDP 형식은 편집하지 않습니다.") };
    private static object ReadValue(CogoPoint p, UDP u) => u switch { UDPString s => p.GetUDPValue(s), UDPDouble d => p.GetUDPValue(d), UDPInteger i => p.GetUDPValue(i), UDPBoolean b => p.GetUDPValue(b), _ => "" };
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "descriptionSet.create") return new { handle = PointDescriptionKeySetCollection.GetPointDescriptionKeySets(db).Add(CivilObjectAccess.Text(r, "name")).Handle.ToString() };
        if (op == "descriptionKey.set")
        {
            var set = Set(db, tr, CivilObjectAccess.Text(r, "set")); set.UpgradeOpen(); string code = CivilObjectAccess.Text(r, "code");
            var key = (PointDescriptionKey)tr.GetObject(set.Contains(code) ? set[code] : set.Add(code), OpenMode.ForWrite);
            if (r["format"] is not null) key.Format = r["format"]!.ToString();
            if (r["style"] is not null) { key.StyleId = CivilObjectAccess.Style(tr, db, "point", r["style"]!.ToString()); key.ApplyStyleId = true; }
            if (r["labelStyle"] is not null) { key.LabelStyleId = CivilObjectAccess.Style(tr, db, "pointLabel", r["labelStyle"]!.ToString()); key.ApplyLabelStyleId = true; }
            if (r["layer"] is not null) { key.LayerId = PrimitiveAccess.Layer(db, tr, r); key.ApplyLayerId = true; }
            return KeyState(key);
        }
        if (op == "pointUdp.create")
        {
            var classes = CivilDocument.GetCivilDocument(db).PointUDPClassifications;
            string name = CivilObjectAccess.Text(r, "classification"); var c = classes.Contains(name) ? classes[name] : classes.Add(name);
            string property = CivilObjectAccess.Text(r, "name");
            UDP created = CivilObjectAccess.Text(r, "type") switch { "string" => c.CreateUDP(new AttributeTypeInfoString(property)), "double" => c.CreateUDP(new AttributeTypeInfoDouble(property)),
                "integer" => c.CreateUDP(new AttributeTypeInfoInt(property)), "boolean" => c.CreateUDP(new AttributeTypeInfoBool(property)), _ => throw new ArgumentException("UDP 종류가 잘못됐습니다.") };
            return new { name = created.Name, classification = created.ClassificationName, guid = created.Guid.ToString() };
        }
        foreach (JsonNode? h in (JsonArray)r["handles"]!)
        {
            var p = (CogoPoint)CivilObjectAccess.ByHandle(tr, db, h!.ToString()); p.UpgradeOpen();
            if (op == "cogo.descriptionKeys") p.ApplyDescriptionKeys();
            else
            {
                UDP u = FindUdp(db, r); object value = Value(u, r["value"]);
                switch (u) { case UDPString s: p.SetUDPValue(s, (string)value); break; case UDPDouble d: p.SetUDPValue(d, (double)value); break;
                    case UDPInteger i: p.SetUDPValue(i, (int)value); break; case UDPBoolean b: p.SetUDPValue(b, (bool)value); break; }
            }
        }
        return new { operation = op, count = r["handles"]!.AsArray().Count };
    }
}
