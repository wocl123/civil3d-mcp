using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;
using Surface = Autodesk.Civil.DatabaseServices.Surface;

namespace MyCivil3DMcp.Plugin;

internal static class ProfileChanges
{
    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "profile.create")
        {
            return ValidateCreate(database, transaction, request, details);
        }

        Profile profile = Find(database, transaction, request);
        CivilObjectAccess.Editable(profile);
        request["profile"] = profile.Handle.ToString();
        request["alignment"] = ((Alignment)transaction.GetObject(profile.AlignmentId, OpenMode.ForRead)).Handle.ToString();
        details.Add($"대상: {profile.Name} [{profile.Handle}], {profile.ProfileType}");
        if (request["newName"] is not null)
        {
            string name = CivilObjectAccess.Text(request, "newName");
            CivilObjectAccess.FreeName<Profile>(transaction, database, name, profile.ObjectId, profile.AlignmentId);
            details.Add($"이름: {profile.Name} → {name}");
        }

        CivilPropertyChanges.Validate(database, transaction, request, profile, "profile", details);
        if (request["replacePvis"] is not null)
        {
            if (profile.ProfileType != ProfileType.FG)
            {
                throw new ArgumentException("PVI 형상 교체는 설계종단(FG)만 가능합니다.");
            }

            Alignment alignment = (Alignment)transaction.GetObject(profile.AlignmentId, OpenMode.ForRead);
            ValidatePoints(request["replacePvis"], alignment, details);
            details.Add($"기존 PVI {profile.PVIs.Count}개와 종단 형상을 전부 교체합니다. 연결된 코리더도 달라질 수 있습니다.");
        }

        return $"종단 {profile.Name} 수정";
    }

    private static string ValidateCreate(Database database, Transaction transaction, JsonObject request,
        List<string> details)
    {
        Alignment alignment = CivilObjectAccess.Find<Alignment>(transaction, database,
            CivilObjectAccess.Text(request, "alignment"));
        CivilObjectAccess.Editable(alignment);
        request["alignment"] = alignment.Handle.ToString();
        string name = CivilObjectAccess.Text(request, "name");
        CivilObjectAccess.FreeName<Profile>(transaction, database, name, ObjectId.Null, alignment.ObjectId);
        CivilPropertyChanges.Validate(database, transaction, request, null, "profile", details);
        ObjectId labels = CivilObjectAccess.Style(transaction, database, "profileLabels", request["labelSet"]?.ToString());
        request["labelSet"] = ((Autodesk.Civil.DatabaseServices.Styles.StyleBase)
            transaction.GetObject(labels, OpenMode.ForRead)).Name;
        details.Add($"선형: {alignment.Name} [{alignment.Handle}], 라벨 세트: {request["labelSet"]}");

        string type = CivilObjectAccess.Text(request, "type");
        if (type == "layout")
        {
            if (request["surface"] is not null || request["offset"] is not null
                || request["startStation"] is not null || request["endStation"] is not null)
            {
                throw new ArgumentException("설계종단에는 지표면 종단 옵션을 함께 지정할 수 없습니다.");
            }

            ValidatePoints(request["pvis"], alignment, details);
        }
        else if (type == "surface")
        {
            ValidateSurface(database, transaction, request, alignment, details);
        }
        else
        {
            throw new ArgumentException("종단 종류는 layout 또는 surface여야 합니다.");
        }

        details.Add("종단 객체를 생성합니다. 종단 뷰(그리드)는 별도로 배치해야 합니다.");
        return $"{(type == "layout" ? "설계" : "지표면")}종단 {name} 생성";
    }

    private static void ValidateSurface(Database database, Transaction transaction, JsonObject request,
        Alignment alignment, List<string> details)
    {
        if (request["pvis"] is not null)
        {
            throw new ArgumentException("지표면 종단에는 설계 PVI를 함께 지정할 수 없습니다.");
        }

        Surface surface = CivilObjectAccess.Find<Surface>(transaction, database,
            CivilObjectAccess.Text(request, "surface"));
        request["surface"] = surface.Handle.ToString();
        double start = request["startStation"] is null ? alignment.StartingStation
            : CivilObjectAccess.Number(request["startStation"]);
        double end = request["endStation"] is null ? alignment.EndingStation
            : CivilObjectAccess.Number(request["endStation"]);
        double offset = request["offset"] is null ? 0 : CivilObjectAccess.Number(request["offset"]);
        if (start < alignment.StartingStation || end > alignment.EndingStation || start >= end)
        {
            throw new ArgumentException("지표면 종단의 추출 범위를 선형 범위 안에 지정하세요.");
        }

        request["startStation"] = start;
        request["endStation"] = end;
        request["offset"] = offset;
        details.Add($"원본 지표면: {surface.Name} [{surface.Handle}], 측점 {start}~{end}, 오프셋 {offset}");
    }

    private static void ValidatePoints(JsonNode? node, Alignment alignment, List<string> details)
    {
        IReadOnlyList<ProfileLayoutPoints.Point> points = ProfileLayoutPoints.Read(
            node, alignment.StartingStation, alignment.EndingStation);
        details.AddRange(points.Select(point => $"PVI 측점 {point.Station}, 표고 {point.Elevation}"
            + (point.CurveLength is double length ? $", 대칭 포물선 길이 {length}" : "")));
    }

    private static Profile Find(Database database, Transaction transaction, JsonObject request)
    {
        string key = CivilObjectAccess.Text(request, "profile");
        if (request["alignment"] is null)
        {
            return CivilObjectAccess.Find<Profile>(transaction, database, key);
        }

        Alignment alignment = CivilObjectAccess.Find<Alignment>(transaction, database,
            CivilObjectAccess.Text(request, "alignment"));
        Profile[] candidates = alignment.GetProfileIds().Cast<ObjectId>()
            .Select(id => (Profile)transaction.GetObject(id, OpenMode.ForRead)).ToArray();
        Profile? profile = candidates.FirstOrDefault(item => item.Handle.ToString().Equals(key,
            StringComparison.OrdinalIgnoreCase));
        Profile[] matches = candidates.Where(item => item.Name.Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (profile is null && matches.Length == 1)
        {
            profile = matches[0];
        }

        return profile ?? throw new ArgumentException("해당 선형의 종단이 없거나 이름이 중복됩니다. 핸들을 사용하세요.");
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "profile.create";
        Profile profile = create ? Create(database, transaction, request) : Find(database, transaction, request);
        if (!create)
        {
            profile = (Profile)transaction.GetObject(profile.ObjectId, OpenMode.ForWrite);
        }

        CivilPropertyChanges.Apply(database, transaction, request, profile, "profile");
        JsonNode? points = create ? request["pvis"] : request["replacePvis"];
        if (points is not null)
        {
            Alignment alignment = (Alignment)transaction.GetObject(profile.AlignmentId, OpenMode.ForRead);
            IReadOnlyList<ProfileLayoutPoints.Point> layout = ProfileLayoutPoints.Read(
                points, alignment.StartingStation, alignment.EndingStation);
            profile.Entities.Clear();
            AddPoints(profile, layout);
        }

        return new { profile.Name, handle = profile.Handle.ToString(), type = profile.ProfileType.ToString() };
    }

    private static Profile Create(Database database, Transaction transaction, JsonObject request)
    {
        Alignment alignment = CivilObjectAccess.Find<Alignment>(transaction, database,
            CivilObjectAccess.Text(request, "alignment"));
        ObjectId layer = CivilObjectAccess.Layer(transaction, database, request["layer"]?.ToString());
        ObjectId style = CivilObjectAccess.Style(transaction, database, "profile", request["style"]?.ToString());
        ObjectId labels = CivilObjectAccess.Style(transaction, database, "profileLabels", request["labelSet"]?.ToString());
        string name = CivilObjectAccess.Text(request, "name");
        ObjectId id;
        if (CivilObjectAccess.Text(request, "type") == "layout")
        {
            id = Profile.CreateByLayout(name, alignment.ObjectId, layer, style, labels);
        }
        else
        {
            Surface surface = CivilObjectAccess.Find<Surface>(transaction, database,
                CivilObjectAccess.Text(request, "surface"));
            id = Profile.CreateFromSurface(name, alignment.ObjectId, surface.ObjectId, layer, style, labels,
                CivilObjectAccess.Number(request["offset"]), CivilObjectAccess.Number(request["startStation"]),
                CivilObjectAccess.Number(request["endStation"]));
        }

        return (Profile)transaction.GetObject(id, OpenMode.ForWrite);
    }

    private static void AddPoints(Profile profile, IReadOnlyList<ProfileLayoutPoints.Point> points)
    {
        // 기존 형상을 비운 뒤 AddPVI는 종단 범위 캐시 때문에 실패할 수 있다. 고정 접선으로 먼저 구성한다.
        for (int index = 1; index < points.Count; index++)
        {
            ProfileLayoutPoints.Point before = points[index - 1];
            ProfileLayoutPoints.Point after = points[index];
            profile.Entities.AddFixedTangent(new Point2d(before.Station, before.Elevation),
                new Point2d(after.Station, after.Elevation));
        }

        foreach (ProfileLayoutPoints.Point point in points.Skip(1).Take(points.Count - 2))
        {
            if (point.CurveLength is double length)
            {
                ProfilePVI pvi = profile.PVIs.GetPVIAt(point.Station, point.Elevation);
                profile.Entities.AddFreeSymmetricParabolaByPVIAndCurveLength(pvi, length);
            }
        }
    }
}
