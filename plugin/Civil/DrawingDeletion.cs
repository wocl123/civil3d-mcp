using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 선형·종단·코리더 삭제. 두 단계로 나눈다.
///   Preview (읽기): 무엇이 지워지는지와 연관된 객체를 알려 준다.
///                   함께 지워지는 것(종단, 종단 뷰, 그 선형·종단을 쓰는 코리더)과 영향을 받는 것(샘플 라인 그룹, 오프셋 선형 등).
///   Delete  (편집): 미리 본 그 객체들만 지운다. 핸들·이름·종류가 미리 볼 때와 다르면 아무것도 지우지 않는다.
/// Delete는 DrawingOperations.Apply 안에서 돌아, Undo 한 번으로 되돌릴 수 있다.
/// </summary>
internal static class DrawingDeletion
{
    public sealed record Target(string Kind, string Handle, string Name);

    // 선형·종단을 쓰는 코리더. 이 코리더가 쓰는 다른 선형과 코리더 서피스(코리더와 함께 사라짐)도 알려 준다.
    public sealed record CorridorLink(string Name, string Handle, IReadOnlyList<string> Alignments, IReadOnlyList<string> Surfaces);

    public sealed record PreviewItem(string Kind, string Name, string Handle, string? Alignment,
        IReadOnlyList<string> Profiles, int ProfileViews, IReadOnlyList<string> SampleLineGroups,
        IReadOnlyList<string> OffsetAlignments, IReadOnlyList<CorridorLink> Corridors);

    public sealed record PreviewResult(IReadOnlyList<PreviewItem> Items, IReadOnlyList<string> NotFound);

    public sealed record DeleteResult(IReadOnlyList<Target> Deleted, int Profiles, int ProfileViews, int Corridors);

    // ── 미리 보기
    public static PreviewResult Preview(Document document, JsonObject? parameters)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Corridors corridors = Corridors.Read(transaction);
        List<PreviewItem> items = new();
        List<string> notFound = new();
        HashSet<string> seen = new(StringComparer.OrdinalIgnoreCase);

        // 선형: 전부, 또는 이름·핸들로
        IEnumerable<Alignment> alignments = parameters?["allAlignments"]?.GetValue<bool>() == true
            ? AlignmentQueries.AllAlignments(transaction)
            : Keys(parameters?["alignments"], "alignments").Select(key => Find(() => AlignmentQueries.ResolveAlignment(transaction, key), key, notFound))
                .OfType<Alignment>();
        foreach (Alignment alignment in alignments)
        {
            if (!seen.Add(alignment.Handle.ToString())) continue;
            List<ObjectId> profileIds = alignment.GetProfileIds().Cast<ObjectId>().ToList();
            List<string> profiles = profileIds
                .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Profile>().Select(profile => profile.Name).ToList();
            List<string> groups = alignment.GetSampleLineGroupIds().Cast<ObjectId>()
                .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<SampleLineGroup>().Select(group => group.Name).ToList();
            List<string> children = alignment.GetChildOffsetAlignmentIds().Cast<ObjectId>()
                .Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<Alignment>().Select(child => child.Name).ToList();
            // 이 선형이나 그 종단을 기준선으로 쓰는 코리더는 함께 지워야 선형을 지울 수 있다.
            items.Add(new PreviewItem("alignment", alignment.Name, alignment.Handle.ToString(), null,
                profiles, alignment.GetProfileViewIds().Count, groups, children,
                corridors.Using(profileIds.Prepend(alignment.ObjectId))));
        }

        // 종단: { profile, alignment? }
        if (parameters?["profiles"] is JsonArray list)
            foreach (JsonNode? entry in list)
            {
                string key = entry?["profile"]?.ToString() ?? "";
                string? owner = entry?["alignment"]?.ToString();
                // 튜플은 null이 될 수 없어 nullable 튜플로 "못 찾음"을 구별한다.
                if (Find<(Alignment, Profile)?>(() => ProfileQueries.Resolve(transaction, key, owner), key, notFound) is not { } pair) continue;
                (Alignment alignment, Profile profile) = pair;
                if (!seen.Add(profile.Handle.ToString())) continue;
                // 그 선형을 함께 지우면 종단은 선형과 함께 지워지므로 따로 넣지 않는다.
                if (seen.Contains(alignment.Handle.ToString())) continue;
                items.Add(new PreviewItem("profile", profile.Name, profile.Handle.ToString(), alignment.Name,
                    [], 0, [], [], corridors.Using([profile.ObjectId])));
            }

        // 코리더: 이름·핸들로 (선형은 남는다)
        foreach (string key in Keys(parameters?["corridors"], "corridors"))
        {
            if (Find(() => corridors.Resolve(key), key, notFound) is not { } corridor) continue;
            if (!seen.Add(corridor.Handle)) continue;
            items.Add(new PreviewItem("corridor", corridor.Name, corridor.Handle, null, [], 0, [], [], [corridor]));
        }

        if (items.Count == 0 && notFound.Count == 0) throw new ArgumentException("지울 선형, 종단 또는 코리더를 하나 이상 주세요.");
        return new PreviewResult(items, notFound);
    }

    // ── 지우기
    public static DeleteResult Delete(Document document, IReadOnlyList<Target> targets)
    {
        if (targets.Count is 0 or > 1000) throw new ArgumentException("targets must have 1 to 1000 items.");
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();

        // 먼저 모두 확인한다: 하나라도 바뀌었으면 아무것도 지우지 않는다.
        List<(Target Target, Entity Entity)> found = targets.Select(target => (target, Open(transaction, database, target))).ToList();

        // 지울 목록에 없는 코리더가 쓰는 선형·종단은 지우지 않는다(미리 본 뒤 코리더가 새로 생긴 경우).
        HashSet<ObjectId> erasing = found.Select(item => item.Entity.ObjectId).ToHashSet();
        Corridors corridors = Corridors.Read(transaction);
        foreach ((Target target, Entity entity) in found)
            if (entity is not Corridor && corridors.Using([entity.ObjectId]).FirstOrDefault(link => !erasing.Contains(corridors.IdOf(link))) is { } kept)
                throw new InvalidOperationException($"{target.Name}은(는) 코리더 {kept.Name}에서 쓰여 지우지 않았습니다. 다시 확인하세요.");

        // 코리더 → 종단 뷰 → 종단 → 선형 순서로 지운다. 이미 함께 지워진 것은 건너뛴다.
        int corridorCount = 0, profiles = 0, views = 0;
        foreach ((_, Entity entity) in found.Where(item => item.Entity is Corridor))
            corridorCount += Erase(transaction, entity.ObjectId);
        foreach ((_, Entity entity) in found.Where(item => item.Entity is not Corridor))
        {
            if (entity is Alignment alignment)
            {
                foreach (ObjectId id in alignment.GetProfileViewIds()) views += Erase(transaction, id);
                foreach (ObjectId id in alignment.GetProfileIds()) profiles += Erase(transaction, id);
            }
            Erase(transaction, entity.ObjectId);
        }
        transaction.Commit();
        return new DeleteResult(targets, profiles, views, corridorCount);
    }

    // 핸들로 열고, 미리 볼 때와 같은 종류·이름인지 확인한다.
    private static Entity Open(Transaction transaction, Database database, Target target)
    {
        if (!long.TryParse(target.Handle, System.Globalization.NumberStyles.HexNumber, null, out long value) ||
            !database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased)
            throw new ArgumentException($"{target.Name}({target.Handle})을(를) 찾지 못했습니다.");
        Entity entity = (Entity)transaction.GetObject(id, OpenMode.ForRead);
        (bool kind, string name) = entity switch
        {
            Alignment alignment => (target.Kind == "alignment", alignment.Name),
            Profile profile => (target.Kind == "profile", profile.Name),
            Corridor corridor => (target.Kind == "corridor", corridor.Name),
            _ => (false, "")
        };
        if (!kind || name != target.Name)
            throw new InvalidOperationException($"{target.Name}이(가) 미리 본 뒤 바뀌어 있어 적용하지 않았습니다. 다시 확인하세요.");
        return entity;
    }

    private static int Erase(Transaction transaction, ObjectId id)
    {
        if (id.IsErased || transaction.GetObject(id, OpenMode.ForWrite) is not Entity entity || entity.IsErased) return 0;
        entity.Erase();
        return 1;
    }

    // 도면의 코리더와 각 코리더가 기준선으로 쓰는 선형·종단.
    private sealed class Corridors
    {
        private readonly Dictionary<ObjectId, List<CorridorLink>> _users = new();
        private readonly Dictionary<CorridorLink, ObjectId> _ids = new();

        public static Corridors Read(Transaction transaction)
        {
            Corridors result = new();
            CivilDocument? civil = CivilApplication.ActiveDocument;
            if (civil is null) return result;
            foreach (ObjectId id in civil.CorridorCollection)
            {
                if (transaction.GetObject(id, OpenMode.ForRead) is not Corridor corridor) continue;
                HashSet<ObjectId> used = new();
                foreach (Baseline baseline in corridor.Baselines)
                {
                    // 기준선 종류(피처 라인 기준선 등)에 따라 선형·종단이 없을 수 있다.
                    try { if (!baseline.AlignmentId.IsNull) used.Add(baseline.AlignmentId); } catch (System.Exception) { }
                    try { if (!baseline.ProfileId.IsNull) used.Add(baseline.ProfileId); } catch (System.Exception) { }
                }
                List<string> alignments = used.Select(item => transaction.GetObject(item, OpenMode.ForRead)).OfType<Alignment>()
                    .Select(alignment => alignment.Name).ToList();
                List<string> surfaces = new();
                try { surfaces.AddRange(corridor.CorridorSurfaces.Select(surface => surface.Name)); } catch (System.Exception) { }
                CorridorLink link = new(corridor.Name, corridor.Handle.ToString(), alignments, surfaces);
                result._ids[link] = id;
                foreach (ObjectId item in used)
                {
                    if (!result._users.TryGetValue(item, out List<CorridorLink>? links)) result._users[item] = links = new();
                    links.Add(link);
                }
            }
            return result;
        }

        // 이 객체들 중 하나라도 쓰는 코리더.
        public IReadOnlyList<CorridorLink> Using(IEnumerable<ObjectId> ids) =>
            ids.SelectMany(id => _users.GetValueOrDefault(id) ?? []).Distinct().ToList();

        public ObjectId IdOf(CorridorLink link) => _ids[link];

        public CorridorLink Resolve(string key)
        {
            List<CorridorLink> matches = _ids.Keys.Where(link => link.Handle.Equals(key, StringComparison.OrdinalIgnoreCase)).ToList();
            if (matches.Count == 0) matches = _ids.Keys.Where(link => link.Name == key).ToList();
            return matches.Count switch
            {
                1 => matches[0],
                0 => throw new ArgumentException($"Corridor '{key}' was not found."),
                _ => throw new ArgumentException($"Several corridors are named '{key}'. Use the handle.")
            };
        }
    }

    private static IEnumerable<string> Keys(JsonNode? value, string name) => value switch
    {
        null => [],
        JsonArray array when array.Count <= 500 => array.Select(item => item?.ToString() ?? "").Where(key => key.Length > 0),
        _ => throw new ArgumentException($"{name} must be an array of up to 500 names or handles.")
    };

    // 못 찾거나 이름이 여럿이면 notFound에 이유를 적고 건너뛴다.
    private static T? Find<T>(Func<T> resolve, string key, List<string> notFound)
    {
        try { return resolve(); }
        catch (ArgumentException ex) { notFound.Add($"{key}: {ex.Message}"); return default; }
    }

    // 브리지 매개변수 → 지울 목록.
    public static List<Target> ReadTargets(JsonNode? value)
    {
        if (value is not JsonArray array || array.Count is 0 or > 1000)
            throw new ArgumentException("targets must be an array of 1 to 1000 items.");
        return array.Select(item => new Target(
            item?["kind"]?.ToString() is "alignment" or "profile" or "corridor" ? item["kind"]!.ToString()
                : throw new ArgumentException("kind must be alignment, profile or corridor."),
            item?["handle"]?.ToString() ?? throw new ArgumentException("handle is required."),
            item?["name"]?.ToString() ?? throw new ArgumentException("name is required."))).ToList();
    }
}
