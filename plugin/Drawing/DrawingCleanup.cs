using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.DatabaseServices;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

// 용도를 추측하지 않는다. 명확한 기하/문자 조건만 삭제 후보로 보고한다.
// 숨김·꺼짐·동결·잠금·연결 데이터가 있는 객체와 점·블록·Civil 객체도 검사하되, 주의 사항과 삭제 가능 여부를 함께 적는다.
internal static class DrawingCleanup
{
    private const int ScanLimit = 100000;
    internal sealed record Candidate(string Handle, string Type, string Layer, string Reason, string[] Cautions,
        bool Deletable);

    public static object Inspect(Document document, int offset, int limit)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        (List<Candidate> candidates, int scanned, bool truncated) = Scan(document.Database, transaction);
        return new { scanned, truncated, totalCount = candidates.Count, offset,
            byReason = PrimitiveAccess.CountBy(candidates, item => item.Reason.Split(" (")[0]),
            notDeletable = candidates.Count(item => !item.Deletable),
            items = candidates.Skip(offset).Take(limit).ToArray(),
            note = "모든 객체 종류와 숨김·꺼짐·동결·잠금 객체를 검사했습니다. 후보일 뿐이며 cautions는 삭제 전에 설명하고, "
                + "deletable=false인 후보는 이 정리 도구로 지우지 않습니다." };
    }

    private static (List<Candidate>, int, bool) Scan(Database database, Transaction transaction)
    {
        List<Candidate> candidates = new();
        Dictionary<string, string> kept = new(StringComparer.Ordinal);
        int scanned = 0;
        foreach (Entity entity in PrimitiveAccess.Entities(database, transaction, true))
        {
            if (++scanned > ScanLimit)
            {
                return (candidates, ScanLimit, true);
            }

            string? reason = Reason(transaction, entity, kept);
            if (reason is not null)
            {
                (string[] cautions, bool deletable) = Cautions(transaction, entity);
                candidates.Add(new Candidate(entity.Handle.ToString(), entity.GetType().Name, entity.Layer, reason,
                    cautions, deletable));
            }
        }

        return (candidates, scanned, false);
    }

    private static (string[], bool) Cautions(Transaction transaction, Entity entity)
    {
        LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(entity.LayerId, OpenMode.ForRead);
        using ResultBuffer? data = entity.XData;
        List<string> cautions = new();
        bool deletable = true;
        if (layer.IsLocked || layer.IsDependent)
        {
            cautions.Add(layer.IsLocked ? "잠긴 레이어: 잠금을 풀어야 삭제 가능" : "외부참조 레이어");
            deletable = false;
        }

        if (entity is Autodesk.Civil.DatabaseServices.Entity)
        {
            cautions.Add("Civil 객체: 전용 삭제 도구로 의존 객체를 확인한 뒤 삭제");
            deletable = false;
        }

        if (layer.IsOff || layer.IsFrozen)
        {
            cautions.Add(layer.IsFrozen ? "동결된 레이어" : "꺼진 레이어");
        }

        if (!entity.Visible)
        {
            cautions.Add("숨김 객체");
        }

        if (!entity.ExtensionDictionary.IsNull || entity.GetPersistentReactorIds().Count > 0 || data is not null)
        {
            cautions.Add("연결 데이터(XData·확장 사전·리액터) 있음: 다른 객체가 참조할 수 있음");
        }

        return (cautions.ToArray(), deletable);
    }

    private static string? Reason(Transaction transaction, Entity entity, Dictionary<string, string> kept)
    {
        switch (entity)
        {
            case DBText text when string.IsNullOrWhiteSpace(text.TextString):
                return "내용이 비어 있는 단일행 문자";
            case MText multiline when string.IsNullOrWhiteSpace(multiline.Text):
                return "표시 내용이 비어 있는 여러행 문자";
            case Polyline polyline when polyline.Length == 0 && polyline.NumberOfVertices > 0:
                return "길이가 정확히 0인 폴리선";
            case Line line when line.Length == 0:
                return "길이가 정확히 0인 선";
            case Line line:
                return Duplicate(kept, "LINE|" + LineKey(line), line, "선");
            case DBPoint point:
                return Duplicate(kept, $"POINT|{Coordinates(point.Position)}|{Display(point)}", point, "점");
            case BlockReference block:
                return EmptyBlock(transaction, block)
                    ?? Duplicate(kept, BlockKey(transaction, block), block, "블록 참조");
            case TinSurface surface:
                return Safe(() => surface.GetGeneralProperties().NumberOfPoints == 0) ? "점이 하나도 없는 빈 TIN 지표면" : null;
            case Alignment alignment:
                return Safe(() => alignment.Entities.Count == 0) ? "요소가 하나도 없는 빈 선형" : null;
            default:
                return null;
        }
    }

    // 같은 키의 첫 객체는 남기고, 그 뒤의 것만 중복 후보로 본다.
    private static string? Duplicate(Dictionary<string, string> kept, string key, Entity entity, string label)
    {
        if (kept.TryGetValue(key, out string? first))
        {
            return $"형상·레이어·표시 속성이 같은 중복 {label} (유지할 객체 [{first}])";
        }

        kept[key] = entity.Handle.ToString();
        return null;
    }

    private static string? EmptyBlock(Transaction transaction, BlockReference block)
    {
        BlockTableRecord definition = (BlockTableRecord)transaction.GetObject(block.BlockTableRecord, OpenMode.ForRead);
        bool empty = !definition.IsFromExternalReference && !definition.IsLayout && !definition.Cast<ObjectId>().Any()
            && block.AttributeCollection.Count == 0;
        return empty ? $"정의에 객체가 없는 빈 블록 참조 ({definition.Name})" : null;
    }

    private static bool Safe(Func<bool> test)
    {
        try
        {
            return test();
        }
        catch (System.Exception)
        {
            return false;
        }
    }

    private static string Number(double value) => value.ToString("R", CultureInfo.InvariantCulture);

    private static string Coordinates(Point3d point) => string.Join(",", Number(point.X), Number(point.Y), Number(point.Z));

    // 공간·레이어·색·선종류·선가중치·투명도 등 표시 속성. 하나라도 다르면 중복이 아니다.
    private static string Display(Entity entity)
    {
        var transparency = entity.Transparency;
        string alpha = transparency.IsByAlpha ? transparency.Alpha.ToString(CultureInfo.InvariantCulture)
            : transparency.IsByLayer ? "ByLayer" : "ByBlock";
        return string.Join("|", entity.OwnerId.Handle, entity.LayerId.Handle, entity.Color.ColorMethod,
            entity.Color.ColorValue.ToArgb(), entity.LinetypeId.Handle, Number(entity.LinetypeScale), entity.LineWeight,
            alpha, entity.MaterialId.Handle, entity.PlotStyleName, entity.Visible);
    }

    private static string LineKey(Line line)
    {
        string first = Coordinates(line.StartPoint);
        string second = Coordinates(line.EndPoint);
        if (string.CompareOrdinal(first, second) > 0)
        {
            (first, second) = (second, first);
        }

        return string.Join("|", first, second, Display(line), Number(line.Thickness), line.Normal.ToString());
    }

    // 블록 정의·삽입점·회전·축척·법선과 속성 값이 모두 같아야 중복이다.
    private static string BlockKey(Transaction transaction, BlockReference block)
    {
        IEnumerable<string> attributes = block.AttributeCollection.Cast<ObjectId>()
            .Select(id => (AttributeReference)transaction.GetObject(id, OpenMode.ForRead))
            .Select(attribute => attribute.Tag + "=" + attribute.TextString);
        return string.Join("|", "BLOCK", block.BlockTableRecord.Handle, Coordinates(block.Position), Number(block.Rotation),
            Number(block.ScaleFactors.X), Number(block.ScaleFactors.Y), Number(block.ScaleFactors.Z),
            block.Normal.ToString(), Display(block), string.Join(";", attributes));
    }

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        (List<Candidate> candidates, _, _) = Scan(database, transaction);
        Dictionary<string, Candidate> byHandle = candidates.ToDictionary(item => item.Handle, StringComparer.OrdinalIgnoreCase);
        JsonArray input = request["handles"] as JsonArray ?? throw new ArgumentException("검사한 삭제 후보 핸들이 필요합니다.");
        string[] handles = input.Select(node => node!.GetValue<string>()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (handles.Length is < 1 or > 1000)
        {
            throw new ArgumentException("검사한 후보 1~1000개를 선택하세요.");
        }

        List<string> lines = new();
        foreach (string handle in handles)
        {
            if (!byHandle.TryGetValue(handle, out Candidate? candidate))
            {
                throw new ArgumentException($"[{handle}]은(는) 현재 삭제 후보가 아닙니다. 다시 검사하세요.");
            }

            if (!candidate.Deletable)
            {
                throw new ArgumentException($"[{handle}]은(는) 이 도구로 지우지 않습니다: {string.Join(", ", candidate.Cautions)}");
            }

            string cautions = candidate.Cautions.Length == 0 ? "" : $" · 주의: {string.Join(", ", candidate.Cautions)}";
            lines.Add($"{candidate.Type} [{candidate.Handle}] · 레이어 {candidate.Layer} · {candidate.Reason}{cautions}");
        }

        request["handles"] = new JsonArray(handles.Select(handle => JsonValue.Create(handle)).ToArray());
        PrimitiveAccess.AddItems(details, lines);
        details.Add("정의·블록·레이어를 PURGE하거나 다른 객체를 자동 삭제하지 않습니다.");
        return $"검사한 정리 후보 {handles.Length}개 삭제";
    }
}
