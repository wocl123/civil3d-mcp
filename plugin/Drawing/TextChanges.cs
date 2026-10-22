using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.Colors;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

// 한 줄 문자(DBText)와 여러 줄 문자(MText). 블록 속성·Civil 라벨·치수 문자는 이 경로에서 바꾸지 않는다.
internal static class TextChanges
{
    private const int ShownLength = 200;

    public static object List(Document document, JsonObject? parameters, int offset, int limit)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Entity[] texts = Matching(document.Database, transaction, parameters?["layer"]?.GetValue<string>(),
            parameters?["contains"]?.GetValue<string>()).ToArray();
        return new { totalCount = texts.Length, offset, byKind = PrimitiveAccess.CountBy(texts, Kind),
            byLayer = PrimitiveAccess.CountBy(texts, text => text.Layer),
            items = texts.Skip(offset).Take(limit).Select(text => Info(transaction, text)).ToArray(),
            note = "content는 서식 코드를 뺀 내용이며 200자를 넘으면 잘린다. rotation은 도(°), 좌표는 WCS 도면 단위." };
    }

    // 모형/배치 공간의 문자 중 레이어·내용 조건에 맞는 것.
    private static IEnumerable<Entity> Matching(Database database, Transaction transaction, string? layer,
        string? contains)
    {
        return PrimitiveAccess.Entities(database, transaction, true).Where(entity => entity is DBText or MText)
            .Where(entity => layer is null || string.Equals(entity.Layer, layer, StringComparison.OrdinalIgnoreCase))
            .Where(entity => contains is null || Content(entity).Contains(contains, StringComparison.Ordinal));
    }

    private static object Info(Transaction transaction, Entity text)
    {
        string content = Content(text);
        return new
        {
            handle = text.Handle.ToString(), kind = Kind(text), text.Layer,
            content = content.Length > ShownLength ? content[..ShownLength] : content,
            contentTruncated = content.Length > ShownLength,
            height = Math.Round(Height(text), 3), rotation = Math.Round(Rotation(text) * 180 / Math.PI, 2),
            style = Style(transaction, text), color = PrimitiveAccess.ColorText(text.Color),
            position = PrimitiveAccess.DisplayPoint(Position(text))
        };
    }

    private static string Line(Transaction transaction, Entity text) =>
        $"{Kind(text)} 문자 [{text.Handle}] · 레이어 {text.Layer} · 높이 {PrimitiveAccess.Number(Height(text))} · "
        + $"스타일 {Style(transaction, text)} · \"{Short(Content(text))}\"";

    private static string Short(string content) => content.Length > 40 ? content[..40] + "…" : content;

    private static string Kind(Entity text) => text is MText ? "여러 줄" : "한 줄";

    private static string Content(Entity text) => text is MText multiline ? multiline.Text : ((DBText)text).TextString;

    private static double Height(Entity text) => text is MText multiline ? multiline.TextHeight : ((DBText)text).Height;

    private static double Rotation(Entity text) => text is MText multiline ? multiline.Rotation : ((DBText)text).Rotation;

    private static Point3d Position(Entity text) => text is MText multiline ? multiline.Location : ((DBText)text).Position;

    private static ObjectId StyleId(Entity text) => text is MText multiline ? multiline.TextStyleId : ((DBText)text).TextStyleId;

    private static string Style(Transaction transaction, Entity text) =>
        ((TextStyleTableRecord)transaction.GetObject(StyleId(text), OpenMode.ForRead)).Name;

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "text.create")
        {
            ValidateCreate(database, transaction, request);
            details.Add($"{(request["kind"]?.GetValue<string>() == "multi" ? "여러 줄" : "한 줄")} 문자 · "
                + $"레이어 {request["layer"]} · 스타일 {request["style"]} · 높이 {request["height"]}");
            details.Add("위치(WCS): " + PrimitiveAccess.PointText(PrimitiveAccess.Point(request["position"])));
            details.Add($"내용: \"{CivilObjectAccess.Text(request, "content")}\"");
            return "문자 1개 생성";
        }

        Entity[] targets = Targets(database, transaction, request);
        if (operation == "text.edit")
        {
            ValidateEdit(database, transaction, request, targets);
            details.Add("바꿀 속성: " + string.Join(" · ", EditFields(request)));
            PrimitiveAccess.AddItems(details, targets.Select(text => EditLine(transaction, request, text)).ToArray());
            return $"문자 {targets.Length}개 수정";
        }

        details.Add("종류별: " + string.Join(" · ", PrimitiveAccess.CountBy(targets, Kind)
            .Select(pair => $"{pair.Key} {pair.Value}개")));
        PrimitiveAccess.AddItems(details, targets.Select(text => Line(transaction, text)).ToArray());
        details.Add("한 줄·여러 줄 문자만 삭제합니다. 블록 속성, 치수 문자, Civil 라벨은 대상이 아닙니다.");
        return $"문자 {targets.Length}개 삭제";
    }

    // 핸들 목록 또는 all=true(+filterLayer/contains 조건). 정규화한 핸들을 요청에 남긴다.
    private static Entity[] Targets(Database database, Transaction transaction, JsonObject request)
    {
        bool all = request["all"]?.GetValue<bool>() == true;
        if (all == (request["handles"] is not null))
        {
            throw new ArgumentException("문자 핸들 목록 또는 all=true 중 하나를 지정하세요.");
        }

        Entity[] targets = all ? Matching(database, transaction, request["filterLayer"]?.GetValue<string>(),
                request["contains"]?.GetValue<string>()).Take(1001).ToArray()
            : ((JsonArray)request["handles"]!).Select(node => CivilObjectAccess.ByHandle(transaction, database,
                node!.GetValue<string>())).DistinctBy(entity => entity.ObjectId).ToArray();
        if (targets.Length is < 1 or > 1000 || targets.Any(entity => entity is not (DBText or MText)))
        {
            throw new ArgumentException("한 줄·여러 줄 문자 1~1000개를 지정하세요. 조건에 맞는 문자가 없을 수 있습니다.");
        }

        foreach (Entity entity in targets)
        {
            PrimitiveAccess.Writable(database, transaction, entity);
        }

        request["all"] = false;
        request.Remove("contains");
        request.Remove("filterLayer");
        request["handles"] = new JsonArray(targets.Select(entity => JsonValue.Create(entity.Handle.ToString())).ToArray());
        return targets;
    }

    private static void ValidateCreate(Database database, Transaction transaction, JsonObject request)
    {
        string content = CivilObjectAccess.Text(request, "content");
        if (content.Trim().Length == 0 || content.Length > 1000)
        {
            throw new ArgumentException("문자 내용은 1~1000자로 주세요.");
        }

        PrimitiveAccess.Point(request["position"]);
        PrimitiveAccess.Layer(database, transaction, request);
        StyleId(database, transaction, request);
        request["height"] = request["height"] is null ? database.Textsize : Positive(request, "height");
        if (request["rotationDegrees"] is not null)
        {
            CivilObjectAccess.Number(request["rotationDegrees"]);
        }

        if (request["kind"]?.GetValue<string>() is { } kind && kind is not ("single" or "multi"))
        {
            throw new ArgumentException("문자 종류는 single 또는 multi입니다.");
        }
    }

    private static void ValidateEdit(Database database, Transaction transaction, JsonObject request, Entity[] targets)
    {
        string[] fields = ["content", "find", "height", "rotationDegrees", "style", "layer", "color", "position", "moveBy"];
        if (!fields.Any(field => request[field] is not null))
        {
            throw new ArgumentException("변경할 문자 속성을 지정하세요.");
        }

        if (request["content"] is not null && request["find"] is not null)
        {
            throw new ArgumentException("전체 내용 변경과 찾아 바꾸기를 함께 지정하지 마세요.");
        }

        if (request["content"] is not null && CivilObjectAccess.Text(request, "content") is { Length: 0 or > 1000 })
        {
            throw new ArgumentException("새 문자 내용은 1~1000자로 주세요.");
        }

        if (request["find"] is not null)
        {
            string find = CivilObjectAccess.Text(request, "find");
            CivilObjectAccess.Text(request, "replace");
            Entity? missing = targets.FirstOrDefault(text => find.Length == 0 || !Content(text).Contains(find, StringComparison.Ordinal));
            if (missing is not null)
            {
                throw new ArgumentException($"[{missing.Handle}]에 찾을 문자 '{find}'가 없습니다.");
            }
        }

        if (request["position"] is not null && (targets.Length != 1 || request["moveBy"] is not null))
        {
            throw new ArgumentException("절대 위치 변경은 문자 1개에만 쓰고 이동량과 함께 지정하지 마세요.");
        }

        if (request["height"] is not null)
        {
            Positive(request, "height");
        }

        if (request["color"] is not null && request["color"]!.GetValue<int>() is < 0 or > 256)
        {
            throw new ArgumentException("색상은 ACI 0(ByBlock)~256(ByLayer)입니다.");
        }

        if (request["style"] is not null)
        {
            StyleId(database, transaction, request);
        }

        if (request["layer"] is not null)
        {
            PrimitiveAccess.Layer(database, transaction, request);
        }

        foreach (string key in new[] { "position", "moveBy" }.Where(key => request[key] is not null))
        {
            PrimitiveAccess.Point(request[key]);
        }

        if (request["rotationDegrees"] is not null)
        {
            CivilObjectAccess.Number(request["rotationDegrees"]);
        }
    }

    private static double Positive(JsonObject request, string key)
    {
        double value = CivilObjectAccess.Number(request[key]);
        if (value <= 0)
        {
            throw new ArgumentException("문자 높이는 0보다 커야 합니다.");
        }

        return value;
    }

    private static ObjectId StyleId(Database database, Transaction transaction, JsonObject request)
    {
        TextStyleTable table = (TextStyleTable)transaction.GetObject(database.TextStyleTableId, OpenMode.ForRead);
        ObjectId id = database.Textstyle;
        if (request["style"] is not null)
        {
            string name = CivilObjectAccess.Text(request, "style");
            if (!table.Has(name))
            {
                string names = string.Join(", ", table.Cast<ObjectId>()
                    .Select(styleId => ((TextStyleTableRecord)transaction.GetObject(styleId, OpenMode.ForRead)).Name)
                    .Where(styleName => styleName.Length > 0));
                throw new ArgumentException($"문자 스타일 '{name}'이 없습니다. 사용 가능: {names}");
            }

            id = table[name];
        }

        TextStyleTableRecord style = (TextStyleTableRecord)transaction.GetObject(id, OpenMode.ForRead);
        if (style.IsDependent || style.IsShapeFile)
        {
            throw new ArgumentException("외부참조·셰이프 문자 스타일은 사용할 수 없습니다.");
        }

        request["style"] = style.Name;
        return id;
    }

    private static IEnumerable<string> EditFields(JsonObject request)
    {
        if (request["content"] is not null)
        {
            yield return $"내용 → \"{Short(CivilObjectAccess.Text(request, "content"))}\"";
        }

        if (request["find"] is not null)
        {
            yield return $"찾아 바꾸기 \"{request["find"]}\" → \"{request["replace"]}\"";
        }

        foreach ((string key, string label) in new[] { ("height", "높이"), ("style", "스타일"), ("layer", "레이어"),
            ("color", "색상(ACI)") })
        {
            if (request[key] is not null)
            {
                yield return $"{label} → {request[key]}";
            }
        }

        if (request["rotationDegrees"] is not null)
        {
            yield return $"회전 → {PrimitiveAccess.Number(CivilObjectAccess.Number(request["rotationDegrees"]))}°";
        }

        foreach ((string key, string label) in new[] { ("position", "위치"), ("moveBy", "이동") })
        {
            if (request[key] is not null)
            {
                yield return $"{label} → {PrimitiveAccess.PointText(PrimitiveAccess.Point(request[key]))}";
            }
        }
    }

    private static string EditLine(Transaction transaction, JsonObject request, Entity text)
    {
        string before = Content(text);
        string? after = NewContent(request, text);
        return after is null || after == before ? Line(transaction, text)
            : $"{Kind(text)} 문자 [{text.Handle}] · \"{Short(before)}\" → \"{Short(after)}\"";
    }

    private static string? NewContent(JsonObject request, Entity text)
    {
        if (request["content"] is not null)
        {
            return CivilObjectAccess.Text(request, "content");
        }

        return request["find"] is null ? null
            : Content(text).Replace(CivilObjectAccess.Text(request, "find"), CivilObjectAccess.Text(request, "replace"));
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "text.delete")
        {
            return new { deleted = PrimitiveAccess.Erase(database, transaction, request) };
        }

        if (operation == "text.create")
        {
            return new { created = new[] { Create(database, transaction, request) } };
        }

        string[] handles = ((JsonArray)request["handles"]!).Select(node => node!.GetValue<string>()).ToArray();
        foreach (string handle in handles)
        {
            Entity entity = CivilObjectAccess.ByHandle(transaction, database, handle);
            Entity text = (Entity)transaction.GetObject(entity.ObjectId, OpenMode.ForWrite);
            ApplyProperties(database, transaction, request, text);
        }

        return new { modified = handles };
    }

    private static string Create(Database database, Transaction transaction, JsonObject request)
    {
        Point3d position = PrimitiveAccess.Point(request["position"]);
        string content = CivilObjectAccess.Text(request, "content");
        double height = CivilObjectAccess.Number(request["height"]);
        double rotation = request["rotationDegrees"] is null ? 0
            : CivilObjectAccess.Number(request["rotationDegrees"]) * Math.PI / 180;
        ObjectId style = StyleId(database, transaction, request);
        using Entity text = request["kind"]?.GetValue<string>() == "multi"
            ? new MText { Location = position, Contents = Escape(content), TextHeight = height, Rotation = rotation }
            : new DBText { Position = position, TextString = content, Height = height, Rotation = rotation };
        text.SetDatabaseDefaults(database);
        SetStyle(text, style);
        text.LayerId = PrimitiveAccess.Layer(database, transaction, request);
        return PrimitiveAccess.Append(database, transaction, text).Handle.ToString();
    }

    // 여러 줄 문자의 줄바꿈과 역슬래시를 MText 코드로 바꾼다.
    private static string Escape(string content) =>
        content.Replace("\\", "\\\\").Replace("{", "\\{").Replace("}", "\\}").Replace("\r\n", "\\P").Replace("\n", "\\P");

    private static void SetStyle(Entity text, ObjectId style)
    {
        if (text is MText multiline)
        {
            multiline.TextStyleId = style;
        }
        else
        {
            ((DBText)text).TextStyleId = style;
        }
    }

    private static void ApplyProperties(Database database, Transaction transaction, JsonObject request, Entity text)
    {
        string? content = NewContent(request, text);
        if (content is not null && text is MText multiline)
        {
            // 찾아 바꾸기는 서식을 남기려고 원문 코드에서 바꾼다. 서식 코드에 걸쳐 있으면 서식 없이 새로 쓴다.
            string find = request["find"] is null ? "" : Escape(CivilObjectAccess.Text(request, "find"));
            multiline.Contents = find.Length > 0 && multiline.Contents.Contains(find, StringComparison.Ordinal)
                ? multiline.Contents.Replace(find, Escape(CivilObjectAccess.Text(request, "replace")))
                : Escape(content);
        }
        else if (content is not null)
        {
            ((DBText)text).TextString = content;
        }

        if (request["height"] is not null)
        {
            double height = CivilObjectAccess.Number(request["height"]);
            if (text is MText mtext)
            {
                mtext.TextHeight = height;
            }
            else
            {
                ((DBText)text).Height = height;
            }
        }

        if (request["rotationDegrees"] is not null)
        {
            double rotation = CivilObjectAccess.Number(request["rotationDegrees"]) * Math.PI / 180;
            if (text is MText mtext)
            {
                mtext.Rotation = rotation;
            }
            else
            {
                ((DBText)text).Rotation = rotation;
            }
        }

        if (request["style"] is not null)
        {
            SetStyle(text, StyleId(database, transaction, request));
        }

        if (request["layer"] is not null)
        {
            text.LayerId = PrimitiveAccess.Layer(database, transaction, request);
        }

        if (request["color"] is not null)
        {
            short index = (short)request["color"]!.GetValue<int>();
            ColorMethod method = index == 256 ? ColorMethod.ByLayer : index == 0 ? ColorMethod.ByBlock : ColorMethod.ByAci;
            text.Color = Color.FromColorIndex(method, index);
        }

        if (request["position"] is not null)
        {
            Move(text, PrimitiveAccess.Point(request["position"]) - Position(text));
        }

        if (request["moveBy"] is not null)
        {
            Move(text, PrimitiveAccess.Point(request["moveBy"]) - Point3d.Origin);
        }

        if (text is DBText single && single.Justify != AttachmentPoint.BaseLeft)
        {
            single.AdjustAlignment(database);
        }
    }

    // 맞춤 기준점(AlignmentPoint)도 함께 옮기도록 변환으로 이동한다.
    private static void Move(Entity text, Vector3d offset) => text.TransformBy(Matrix3d.Displacement(offset));
}
