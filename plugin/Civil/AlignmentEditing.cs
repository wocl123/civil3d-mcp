using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 선형 속성 편집: 이름, 설명, 스타일, 레이어, 라벨 세트, 설계속도. 형상(요소)은 바꾸지 않는다.
///   Preview (읽기): 대상 선형마다 바뀌기 전 → 후를 계산하고 확인한다(스타일·레이어가 있는지, 이름이 겹치지 않는지).
///   Apply   (편집): 미리 본 값 그대로 적용한다. 핸들·이름이 미리 볼 때와 다르면 아무것도 바꾸지 않는다.
/// Apply는 DrawingOperations.Apply 안에서 돌아, Undo 한 번으로 되돌릴 수 있다.
/// </summary>
internal static class AlignmentEditing
{
    public sealed record Change(string Property, string From, string To);
    public sealed record PreviewItem(string Name, string Handle, IReadOnlyList<Change> Changes, string? Blocked);
    public sealed record PreviewResult(IReadOnlyList<PreviewItem> Items, IReadOnlyList<string> NotFound);
    public sealed record Speed(double Station, double Value);
    // 적용할 값(미리 보기에서 확정). null이면 그 속성은 그대로 둔다.
    public sealed record Edit(string Handle, string Name, string? NewName, string? Description, string? Style,
        string? Layer, string? LabelSet, IReadOnlyList<Speed>? DesignSpeeds);
    public sealed record EditResult(IReadOnlyList<string> Edited, int Changes);

    // ── 미리 보기
    public static PreviewResult Preview(Document document, JsonObject? parameters)
    {
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();
        CivilDocument civil = CivilApplication.ActiveDocument ?? throw new InvalidOperationException("Civil 3D 도면이 아닙니다.");
        List<string> notFound = new();

        // 대상
        List<Alignment> targets = parameters?["allAlignments"]?.GetValue<bool>() == true
            ? AlignmentQueries.AllAlignments(transaction)
            : Keys(parameters?["alignments"]).Select(key =>
            {
                try { return AlignmentQueries.ResolveAlignment(transaction, key); }
                catch (ArgumentException ex) { notFound.Add($"{key}: {ex.Message}"); return null; }
            }).OfType<Alignment>().DistinctBy(alignment => alignment.Handle).ToList();
        if (targets.Count == 0 && notFound.Count == 0) throw new ArgumentException("바꿀 선형을 하나 이상 주세요.");

        // 바꿀 값: 도면에 있는지 먼저 확인한다(없으면 있는 이름을 알려 준다).
        string? description = parameters?["description"]?.ToString();
        string? style = Optional(parameters?["style"]);
        if (style is not null && !civil.Styles.AlignmentStyles.Contains(style))
            throw new ArgumentException($"선형 스타일 '{style}'이(가) 도면에 없습니다. 있는 스타일: {Names(transaction, civil.Styles.AlignmentStyles.Cast<ObjectId>())}");
        string? layer = Optional(parameters?["layer"]);
        if (layer is not null && !((LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForRead)).Has(layer))
            throw new ArgumentException($"레이어 '{layer}'이(가) 도면에 없습니다. 먼저 레이어를 만들어 주세요.");
        string? labelSet = Optional(parameters?["labelSet"]);
        if (labelSet is not null && !civil.Styles.LabelSetStyles.AlignmentLabelSetStyles.Contains(labelSet))
            throw new ArgumentException($"선형 라벨 세트 '{labelSet}'이(가) 도면에 없습니다. 있는 라벨 세트: " +
                Names(transaction, civil.Styles.LabelSetStyles.AlignmentLabelSetStyles.Cast<ObjectId>()));
        List<Speed>? speeds = ReadSpeeds(parameters?["designSpeeds"]);
        JsonNode? rename = parameters?["rename"];
        if (rename?["to"] is not null && targets.Count > 1) throw new ArgumentException("새 이름(to)은 선형 하나에만 줄 수 있습니다. 여러 선형은 prefix·suffix·find/replace를 쓰세요.");

        // 이름 겹침 확인: 바꾸지 않는 선형의 이름 + 이번에 바뀔 이름들
        HashSet<string> taken = new(AlignmentQueries.AllAlignments(transaction).Where(item => !targets.Contains(item)).Select(item => item.Name),
            StringComparer.OrdinalIgnoreCase);

        List<PreviewItem> items = new();
        foreach (Alignment alignment in targets)
        {
            List<Change> changes = new();
            string? blocked = null;
            string? newName = NewName(alignment.Name, rename);
            if (newName is not null && newName != alignment.Name)
            {
                if (newName.Length == 0 || newName.Length > 255) blocked = "새 이름이 비었거나 너무 깁니다.";
                else if (!taken.Add(newName)) blocked = $"이름 '{newName}'은(는) 이미 있거나 이번에 겹칩니다.";
                changes.Add(new("이름", alignment.Name, newName));
            }
            else taken.Add(alignment.Name);
            if (description is not null && description != alignment.Description) changes.Add(new("설명", alignment.Description, description));
            if (style is not null && style != alignment.StyleName) changes.Add(new("스타일", alignment.StyleName, style));
            if (layer is not null && !layer.Equals(alignment.Layer, StringComparison.OrdinalIgnoreCase)) changes.Add(new("레이어", alignment.Layer, layer));
            if (labelSet is not null) changes.Add(new("라벨 세트", "(현재 라벨)", labelSet));
            if (speeds is not null)
            {
                if (speeds.Any(speed => speed.Station < alignment.StartingStation - 0.001 || speed.Station > alignment.EndingStation + 0.001))
                    blocked ??= $"설계속도 측점이 선형 범위({Station(alignment.StartingStation)}~{Station(alignment.EndingStation)}) 밖입니다.";
                string from = SpeedText(alignment.DesignSpeeds.Cast<DesignSpeed>().Select(item => new Speed(item.Station, item.Value)));
                string to = SpeedText(speeds);
                if (from != to) changes.Add(new("설계속도", from, to));
            }
            items.Add(new PreviewItem(alignment.Name, alignment.Handle.ToString(), changes, blocked));
        }
        return new PreviewResult(items, notFound);
    }

    // ── 적용
    public static EditResult Apply(Document document, IReadOnlyList<Edit> edits)
    {
        if (edits.Count is 0 or > 1000) throw new ArgumentException("edits must have 1 to 1000 items.");
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();
        CivilDocument civil = CivilApplication.ActiveDocument ?? throw new InvalidOperationException("Civil 3D 도면이 아닙니다.");

        // 먼저 모두 확인한다: 하나라도 바뀌었으면 아무것도 바꾸지 않는다.
        List<(Edit Edit, Alignment Alignment)> found = edits.Select(edit =>
        {
            if (!long.TryParse(edit.Handle, NumberStyles.HexNumber, null, out long value) ||
                !database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased ||
                transaction.GetObject(id, OpenMode.ForRead) is not Alignment alignment || alignment.Name != edit.Name)
                throw new InvalidOperationException($"{edit.Name}이(가) 미리 본 뒤 바뀌어 있어 적용하지 않았습니다. 다시 확인하세요.");
            return (edit, alignment);
        }).ToList();

        int count = 0;
        foreach ((Edit edit, Alignment alignment) in found)
        {
            alignment.UpgradeOpen();
            if (edit.NewName is not null) { alignment.Name = edit.NewName; count++; }
            if (edit.Description is not null) { alignment.Description = edit.Description; count++; }
            if (edit.Style is not null) { alignment.StyleId = civil.Styles.AlignmentStyles[edit.Style]; count++; }
            if (edit.Layer is not null) { alignment.Layer = edit.Layer; count++; }
            if (edit.LabelSet is not null) { alignment.ImportLabelSet(civil.Styles.LabelSetStyles.AlignmentLabelSetStyles[edit.LabelSet]); count++; }
            if (edit.DesignSpeeds is not null)
            {
                // 기존 구간을 모두 지우고 새 구간으로 바꾼다.
                // (Remove는 측점으로 지운다. 지워지지 않으면 무한 반복하지 않게 개수로 확인한다.)
                for (int count0 = alignment.DesignSpeeds.Count; count0 > 0; count0--)
                {
                    alignment.DesignSpeeds.Remove(alignment.DesignSpeeds[0].Station);
                    if (alignment.DesignSpeeds.Count != count0 - 1) throw new InvalidOperationException("기존 설계속도를 지우지 못했습니다.");
                }
                foreach (Speed speed in edit.DesignSpeeds.OrderBy(speed => speed.Station)) alignment.DesignSpeeds.Add(speed.Station, speed.Value);
                count++;
            }
        }
        transaction.Commit();
        return new EditResult(found.Select(item => item.Edit.NewName ?? item.Edit.Name).ToList(), count);
    }

    // 브리지 매개변수 → 적용 목록.
    public static List<Edit> ReadEdits(JsonNode? value)
    {
        if (value is not JsonArray array || array.Count is 0 or > 1000) throw new ArgumentException("edits must be an array of 1 to 1000 items.");
        return array.Select(item => new Edit(
            item?["handle"]?.ToString() ?? throw new ArgumentException("handle is required."),
            item["name"]?.ToString() ?? throw new ArgumentException("name is required."),
            Optional(item["newName"]), item["description"]?.ToString(), Optional(item["style"]), Optional(item["layer"]),
            Optional(item["labelSet"]), ReadSpeeds(item["designSpeeds"]))).ToList();
    }

    // rename: { to } 또는 { prefix, suffix, find, replace }
    private static string? NewName(string name, JsonNode? rename)
    {
        if (rename is null) return null;
        if (Optional(rename["to"]) is { } to) return to.Trim();
        string result = name;
        if (Optional(rename["find"]) is { } find) result = result.Replace(find, rename["replace"]?.ToString() ?? "");
        return (rename["prefix"]?.ToString() ?? "") + result + (rename["suffix"]?.ToString() ?? "");
    }

    private static List<Speed>? ReadSpeeds(JsonNode? value)
    {
        if (value is null) return null;
        if (value is not JsonArray array || array.Count is 0 or > 100) throw new ArgumentException("designSpeeds must have 1 to 100 items.");
        List<Speed> speeds = array.Select(item => new Speed(
            item?["station"]?.GetValue<double>() ?? throw new ArgumentException("station is required."),
            item["speed"]?.GetValue<double>() ?? item["value"]?.GetValue<double>() ?? throw new ArgumentException("speed is required."))).ToList();
        if (speeds.Any(speed => speed.Value is < 10 or > 200)) throw new ArgumentException("설계속도는 10~200 km/h로 주세요.");
        if (speeds.Select(speed => Math.Round(speed.Station, 3)).Distinct().Count() != speeds.Count) throw new ArgumentException("같은 측점에 설계속도가 둘 이상입니다.");
        return speeds.OrderBy(speed => speed.Station).ToList();
    }

    private static string SpeedText(IEnumerable<Speed> speeds)
    {
        List<string> parts = speeds.OrderBy(speed => speed.Station).Select(speed => $"{Station(speed.Station)}부터 {speed.Value:0.#}").ToList();
        return parts.Count == 0 ? "(없음)" : string.Join(", ", parts) + " km/h";
    }

    private static string Station(double value) =>
        $"{Math.Floor(value / 1000):0}+{value % 1000:000.00}".Replace(",", ".");

    private static string Names(Transaction transaction, IEnumerable<ObjectId> ids)
    {
        List<string> names = ids.Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Autodesk.Civil.DatabaseServices.Styles.StyleBase>()
            .Select(style => style.Name).ToList();
        return names.Count > 20 ? string.Join(", ", names.Take(20)) + $" 외 {names.Count - 20}개" : string.Join(", ", names);
    }

    private static string? Optional(JsonNode? value) => value?.ToString() is { Length: > 0 } text ? text : null;

    private static IEnumerable<string> Keys(JsonNode? value) => value switch
    {
        null => [],
        JsonArray array when array.Count <= 500 => array.Select(item => item?.ToString() ?? "").Where(key => key.Length > 0),
        _ => throw new ArgumentException("alignments must be an array of up to 500 names or handles.")
    };
}
