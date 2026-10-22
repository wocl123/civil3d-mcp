using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class SectionChanges
{
    internal sealed record SourceInfo(string Name, string Handle, string Type, bool Sampled);
    internal static SourceInfo[] Sources(Database db, ObjectId groupId) => DrawingRevisions.ReadWithRollback(db, temporary => {
        var group = (SampleLineGroup)temporary.GetObject(groupId, OpenMode.ForWrite);
        temporary.GetObject(group.ParentAlignmentId, OpenMode.ForWrite);
        return group.GetSectionSources().Cast<SectionSource>().Select(s => new SourceInfo(s.SourceName,
            s.SourceId.Handle.ToString(), s.SourceType.ToString(), s.IsSampled)).ToArray();
    });
    internal static IEnumerable<SampleLineGroup> Groups(Database db, Transaction tr) =>
        CivilObjectAccess.All<Alignment>(tr, db).SelectMany(a => a.GetSampleLineGroupIds().Cast<ObjectId>())
            .Select(id => (SampleLineGroup)tr.GetObject(id, OpenMode.ForRead));
    internal static T Find<T>(IEnumerable<T> items, string key) where T : Autodesk.Civil.DatabaseServices.Entity
    {
        T[] matches = items.Where(e => e.Handle.ToString().Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length == 0) matches = items.Where(e => e.Name.Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        return matches.Length == 1 ? matches[0] : throw new ArgumentException($"{typeof(T).Name} '{key}' 대상이 없거나 이름이 중복됩니다.");
    }
    internal static IEnumerable<SampleLine> Lines(Database db, Transaction tr) => Groups(db, tr)
        .SelectMany(g => g.GetSampleLineIds().Cast<ObjectId>()).Select(id => (SampleLine)tr.GetObject(id, OpenMode.ForRead));
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        Database db = doc.Database;
        string kind = CivilObjectAccess.Text(r, "kind");
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        object[] items = kind switch
        {
            "sampleGroups" => Groups(db, tr).Select(g => (object)new { name = g.Name, handle = g.Handle.ToString(),
                alignment = g.ParentAlignmentId.Handle.ToString(), lines = g.GetSampleLineIds().Count,
                sources = Sources(db, g.ObjectId) }).ToArray(),
            "sampleLines" => Lines(db, tr).Select(l => (object)new { name = l.Name, handle = l.Handle.ToString(), station = l.Station,
                vertices = l.Vertices.Select((v, index) => new { index, side = v.Side.ToString(), point = PrimitiveAccess.JsonPoint(v.Location) }).ToArray(),
                sections = l.GetSectionIds().Cast<ObjectId>().Select(id => id.Handle.ToString()).ToArray(),
                views = l.GetSectionViewIds().Cast<ObjectId>().Select(id => id.Handle.ToString()).ToArray() }).ToArray(),
            "sectionViews" => Lines(db, tr).SelectMany(l => l.GetSectionViewIds().Cast<ObjectId>())
                .Select(id => (SectionView)tr.GetObject(id, OpenMode.ForRead)).Select(v => (object)new { name = v.Name,
                    handle = v.Handle.ToString(), sampleLine = v.SampleLineId.Handle.ToString(), position = PrimitiveAccess.JsonPoint(v.Location),
                    v.OffsetLeft, v.OffsetRight, v.ElevationMin, v.ElevationMax }).ToArray(),
            _ => throw new ArgumentException("알 수 없는 횡단 조회 종류입니다.")
        };
        return new { total = items.Length, offset, items = items.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < items.Length };
    }

    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "sampleGroup.create")
        {
            Alignment alignment = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment"));
            CivilObjectAccess.Editable(alignment);
            r["alignment"] = alignment.Handle.ToString();
            string name = CivilObjectAccess.Text(r, "name");
            if (Groups(db, tr).Any(g => g.ParentAlignmentId == alignment.ObjectId && g.Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("같은 선형에 동일한 횡단추출선 그룹이 있습니다.");
            details.Add($"선형 {alignment.Name}에 횡단추출선 그룹 {name} 생성");
        }
        else if (op is "sampleGroup.edit" or "sampleLine.create")
        {
            SampleLineGroup group = Find(Groups(db, tr), CivilObjectAccess.Text(r, "group"));
            CivilObjectAccess.Editable(group); CivilObjectAccess.WritableLayer(tr, group.LayerId);
            r["group"] = group.Handle.ToString();
            r["groupState"] = new JsonObject { ["name"] = group.Name,
                ["sources"] = new JsonArray(Sources(db, group.ObjectId).Select(s => (JsonNode)new JsonObject {
                    ["handle"] = s.Handle, ["sampled"] = s.Sampled }).ToArray()),
                ["lines"] = new JsonArray(group.GetSampleLineIds().Cast<ObjectId>().Select(id => JsonValue.Create(id.Handle.ToString())).ToArray()) };
            details.Add($"횡단추출선 그룹 {group.Name} [{group.Handle}]");
            if (op == "sampleGroup.edit")
            {
                if (r["sources"] is not JsonArray sources || sources.Count is < 1 or > 100)
                    throw new ArgumentException("소스 핸들과 추출 여부를 지정하세요.");
                foreach (JsonNode? source in sources)
                    if (!Sources(db, group.ObjectId).Any(s => s.Handle.Equals(source?["handle"]?.ToString(), StringComparison.OrdinalIgnoreCase)))
                        throw new ArgumentException("그룹에 없는 횡단 소스입니다.");
                details.Add("명시한 소스의 횡단 추출 여부를 변경합니다. 기존 횡단·뷰가 갱신될 수 있습니다.");
            }
            else
            {
                string name = CivilObjectAccess.Text(r, "name");
                if (group.GetSampleLineIds().Cast<ObjectId>().Any(id => ((SampleLine)tr.GetObject(id, OpenMode.ForRead)).Name.Equals(name, StringComparison.OrdinalIgnoreCase)))
                    throw new ArgumentException("그룹에 같은 횡단추출선 이름이 있습니다.");
                Point3d[] pts = GeometryExtensions.Points(r, "points", 2);
                if (pts.Any(p => Math.Abs(p.Z) > 1e-9)) throw new ArgumentException("추출선은 WCS XY 좌표(z=0)로 지정하세요.");
            }
        }
        else if (op == "sectionView.create")
        {
            SampleLine line = Find(Lines(db, tr), CivilObjectAccess.Text(r, "sampleLine"));
            CivilObjectAccess.Editable(line); CivilObjectAccess.WritableLayer(tr, line.LayerId);
            r["sampleLine"] = line.Handle.ToString();
            PrimitiveAccess.Point(r["position"]);
            if (Lines(db, tr).SelectMany(l => l.GetSectionViewIds().Cast<ObjectId>()).Any(id => ((SectionView)tr.GetObject(id, OpenMode.ForRead)).Name.Equals(CivilObjectAccess.Text(r, "name"), StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("같은 횡단뷰 이름이 있습니다.");
            details.Add($"추출선 {line.Name}, 측점 {line.Station}에서 횡단뷰 생성");
        }
        else if (op == "sectionView.edit")
        {
            SectionView view = Find(Lines(db, tr).SelectMany(l => l.GetSectionViewIds().Cast<ObjectId>())
                .Select(id => (SectionView)tr.GetObject(id, OpenMode.ForRead)), CivilObjectAccess.Text(r, "sectionView"));
            CivilObjectAccess.Editable(view); PrimitiveAccess.Writable(db, tr, view);
            r["sectionView"] = view.Handle.ToString();
            details.Add($"{view.Name} [{view.Handle}], 위치 {PrimitiveAccess.PointText(view.Location)}, 좌우범위 {view.OffsetLeft}~{view.OffsetRight}, 표고 {view.ElevationMin}~{view.ElevationMax}");
            if (!new[] { "position", "elevationMin", "offsetLeft" }.Any(k => r[k] is not null)) throw new ArgumentException("변경할 횡단뷰 범위를 지정하세요.");
        }
        else throw new ArgumentException("알 수 없는 횡단 작업입니다.");
        foreach (var pair in new[] { ("elevationMin", "elevationMax"), ("offsetLeft", "offsetRight") })
            if (r[pair.Item1] is not null || r[pair.Item2] is not null)
                if (CivilObjectAccess.Number(r[pair.Item1]) >= CivilObjectAccess.Number(r[pair.Item2])) throw new ArgumentException("범위의 최솟값은 최댓값보다 작아야 합니다.");
        if (r["position"] is not null) PrimitiveAccess.Point(r["position"]);
        details.AddRange(CivilPlanDetails.Describe(r));
        return CivilPlanDetails.Title(op);
    }

    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        ObjectId id;
        switch (op)
        {
            case "sampleGroup.create":
                Alignment alignment = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment"));
                alignment.UpgradeOpen();
                id = SampleLineGroup.Create(CivilObjectAccess.Text(r, "name"), alignment.ObjectId); break;
            case "sampleGroup.edit":
                SampleLineGroup group = Find(Groups(db, tr), CivilObjectAccess.Text(r, "group"));
                group.UpgradeOpen();
                tr.GetObject(group.ParentAlignmentId, OpenMode.ForWrite);
                foreach (JsonNode? item in (JsonArray)r["sources"]!)
                    group.GetSectionSources().Cast<SectionSource>().Single(s => s.SourceId.Handle.ToString().Equals(item!["handle"]!.ToString(), StringComparison.OrdinalIgnoreCase)).IsSampled = item!["sampled"]!.GetValue<bool>();
                id = group.ObjectId; break;
            case "sampleLine.create":
                var pts = new Point2dCollection(GeometryExtensions.Points(r, "points", 2).Select(p => new Point2d(p.X, p.Y)).ToArray());
                SampleLineGroup parentGroup = Find(Groups(db, tr), CivilObjectAccess.Text(r, "group"));
                parentGroup.UpgradeOpen();
                tr.GetObject(parentGroup.ParentAlignmentId, OpenMode.ForWrite);
                id = SampleLine.Create(CivilObjectAccess.Text(r, "name"), parentGroup.ObjectId, pts); break;
            case "sectionView.create":
                SampleLine parentLine = Find(Lines(db, tr), CivilObjectAccess.Text(r, "sampleLine"));
                parentLine.UpgradeOpen();
                id = SectionView.Create(CivilObjectAccess.Text(r, "name"), parentLine.ObjectId, PrimitiveAccess.Point(r["position"])); break;
            case "sectionView.edit":
                SectionView view = Find(Lines(db, tr).SelectMany(l => l.GetSectionViewIds().Cast<ObjectId>()).Select(i => (SectionView)tr.GetObject(i, OpenMode.ForRead)), CivilObjectAccess.Text(r, "sectionView"));
                view.UpgradeOpen(); id = view.ObjectId;
                if (r["position"] is not null) view.Location = PrimitiveAccess.Point(r["position"]);
                if (r["elevationMin"] is not null)
                {
                    view.IsElevationRangeAutomatic = false;
                    double min = CivilObjectAccess.Number(r["elevationMin"]), max = CivilObjectAccess.Number(r["elevationMax"]);
                    if (min >= view.ElevationMax) view.ElevationMax = max;
                    view.ElevationMin = min; view.ElevationMax = max;
                }
                if (r["offsetLeft"] is not null)
                {
                    view.IsOffsetRangeAutomatic = false;
                    view.OffsetLeft = CivilObjectAccess.Number(r["offsetLeft"]); view.OffsetRight = CivilObjectAccess.Number(r["offsetRight"]);
                }
                break;
            default: throw new ArgumentException("알 수 없는 횡단 작업입니다.");
        }
        return new { handle = id.Handle.ToString(), operation = op };
    }
}
