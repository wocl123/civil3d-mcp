using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class SampleLineEditing
{
    private static double N(JsonObject r, string key) => CivilObjectAccess.Number(r[key]);
    private static void Guard(Database db, Transaction tr, Autodesk.Civil.DatabaseServices.Entity e)
    {
        CivilObjectAccess.Editable(e); PrimitiveAccess.Writable(db, tr, e);
    }
    private static JsonObject State(SampleLine line) => new() { ["name"] = line.Name, ["station"] = line.Station,
        ["locked"] = line.LockToStation, ["fingerprint"] = line.ComputeFingerPrint().ToString("X"),
        ["vertices"] = new JsonArray(line.Vertices.Select(v => (JsonNode)PrimitiveAccess.JsonPoint(v.Location)).ToArray()) };
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        bool batch = CivilObjectAccess.Text(r, "operation") == "sampleLine.batch";
        SampleLine? line = batch ? null : SectionChanges.Find(SectionChanges.Lines(db, tr), CivilObjectAccess.Text(r, "sampleLine"));
        var group = line is null ? SectionChanges.Find(SectionChanges.Groups(db, tr), CivilObjectAccess.Text(r, "group"))
            : (SampleLineGroup)tr.GetObject(line.GroupId, OpenMode.ForRead);
        var alignment = (Alignment)tr.GetObject(group.ParentAlignmentId, OpenMode.ForRead);
        if (r["leftWidth"] is not null || r["rightWidth"] is not null) Station(alignment, line?.Station ?? N(r, "startStation"));
        Guard(db, tr, group); Guard(db, tr, alignment);
        r["group"] = group.Handle.ToString();
        r["parentState"] = new JsonObject { ["alignment"] = alignment.ComputeFingerPrint().ToString("X"),
            ["group"] = group.ComputeFingerPrint().ToString("X"),
            ["lines"] = new JsonArray(group.GetSampleLineIds().Cast<ObjectId>().Select(id => JsonValue.Create(id.Handle.ToString())).ToArray()) };
        if (line is not null)
        {
            Guard(db, tr, line); r["sampleLine"] = line.Handle.ToString(); r["lineState"] = State(line);
            foreach (ObjectId id in line.GetSectionIds().Cast<ObjectId>().Concat(line.GetSectionViewIds().Cast<ObjectId>()))
                if (tr.GetObject(id, OpenMode.ForRead) is Autodesk.Civil.DatabaseServices.Entity child) Guard(db, tr, child);
            if (!new[] { "station", "leftWidth", "rightWidth", "vertices", "newName", "lockToStation" }.Any(k => r[k] is not null))
                throw new ArgumentException("변경할 측점·폭·정점·이름을 지정하세요.");
            if (r["newName"] is not null && SectionChanges.Lines(db, tr).Any(l => l.GroupId == group.ObjectId && l.ObjectId != line.ObjectId
                && l.Name.Equals(CivilObjectAccess.Text(r, "newName"), StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("동일한 추출선 이름이 있습니다.");
            if (r["station"] is not null) Station(alignment, N(r, "station"));
            if (r["vertices"] is JsonArray vertices)
            {
                if (r["station"] is not null || r["leftWidth"] is not null || r["rightWidth"] is not null)
                    throw new ArgumentException("정점 편집은 측점·폭 편집과 별도 계획으로 지정하세요.");
                if (vertices.Count is < 1 or > 1000) throw new ArgumentException("정점 편집은 1~1000개입니다.");
                HashSet<int> seen = new();
                foreach (JsonNode? v in vertices)
                {
                    int index = v!["index"]!.GetValue<int>(); Point3d p = PrimitiveAccess.Point(v["point"]);
                    if (!seen.Add(index) || index < 0 || index >= line.Vertices.Count || line.Vertices[index].Side == SampleLineVertexSideType.Center
                        || Math.Abs(p.Z) > 1e-9) throw new ArgumentException("중심점을 제외한 유일한 정점 인덱스와 XY(z=0)를 지정하세요.");
                }
            }
        }
        else
        {
            double start = N(r, "startStation"), end = N(r, "endStation"), interval = N(r, "interval");
            Station(alignment, start); Station(alignment, end);
            if (end < start || interval <= 0 || (end - start) / interval > 199) throw new ArgumentException("양의 간격으로 최대 200개를 생성하세요.");
            string prefix = CivilObjectAccess.Text(r, "name");
            int count = (int)Math.Floor((end - start) / interval + 1e-9) + 1;
            if (SectionChanges.Lines(db, tr).Any(l => l.GroupId == group.ObjectId && Enumerable.Range(1, count)
                .Any(i => l.Name.Equals(prefix + "-" + i, StringComparison.OrdinalIgnoreCase)))) throw new ArgumentException("생성할 추출선 이름이 이미 있습니다.");
            if (r["leftWidth"] is null || r["rightWidth"] is null) throw new ArgumentException("좌우 폭을 모두 지정하세요.");
            details.Add($"{start}~{end}, 간격 {interval}: {count}개. 끝 측점은 간격에 일치할 때만 포함합니다.");
        }
        foreach (string key in new[] { "leftWidth", "rightWidth" })
            if (r[key] is not null && N(r, key) <= 0) throw new ArgumentException("좌우 폭은 양수입니다.");
        if (line is not null && (r["leftWidth"] is not null || r["rightWidth"] is not null)
            && line.Vertices.Count(v => v.Side != SampleLineVertexSideType.Center) != 2)
            throw new ArgumentException("꺾인 추출선은 폭 대신 정점 좌표를 편집하세요.");
        details.Add("기존 횡단·횡단뷰가 갱신됩니다. 폭은 선형에 직각인 좌우 거리입니다.");
        details.AddRange(CivilPlanDetails.Describe(r));
        return batch ? "횡단추출선 일정 간격 생성" : "횡단추출선 측점·폭·정점 편집";
    }
    private static void Station(Alignment a, double s)
    {
        if (s < a.StartingStation || s > a.EndingStation) throw new ArgumentException("측점이 선형 범위 밖입니다.");
        if (a.StationEquations.Count > 0) throw new ArgumentException("측점 방정식이 있는 선형은 현재 이 도구에서 지원하지 않습니다.");
    }
    private static void Widths(SampleLine line, Alignment a, JsonObject r)
    {
        foreach (SampleLineVertex vertex in line.Vertices)
        {
            string? key = vertex.Side == SampleLineVertexSideType.Left ? "leftWidth"
                : vertex.Side == SampleLineVertexSideType.Right ? "rightWidth" : null;
            if (key is null || r[key] is null) continue;
            double x = 0, y = 0; a.PointLocation(line.Station, key == "leftWidth" ? -N(r, key) : N(r, key), ref x, ref y);
            vertex.Location = new Point3d(x, y, 0);
        }
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var group = SectionChanges.Find(SectionChanges.Groups(db, tr), CivilObjectAccess.Text(r, "group")); group.UpgradeOpen();
        var a = (Alignment)tr.GetObject(group.ParentAlignmentId, OpenMode.ForWrite);
        if (CivilObjectAccess.Text(r, "operation") == "sampleLine.batch")
        {
            List<string> handles = new(); double start = N(r, "startStation"), end = N(r, "endStation"), interval = N(r, "interval");
            int count = (int)Math.Floor((end - start) / interval + 1e-9) + 1;
            for (int i = 0; i < count; i++)
            {
                ObjectId id = SampleLine.Create(CivilObjectAccess.Text(r, "name") + "-" + (i + 1), group.ObjectId, Math.Min(end, start + i * interval));
                var line = (SampleLine)tr.GetObject(id, OpenMode.ForWrite); Widths(line, a, r); handles.Add(id.Handle.ToString());
            }
            return new { created = handles };
        }
        var target = SectionChanges.Find(SectionChanges.Lines(db, tr), CivilObjectAccess.Text(r, "sampleLine")); target.UpgradeOpen();
        if (r["station"] is not null) { bool locked = target.LockToStation; target.LockToStation = false; target.Station = N(r, "station"); target.LockToStation = locked; }
        Widths(target, a, r);
        if (r["vertices"] is JsonArray vertices) foreach (JsonNode? v in vertices) target.Vertices[v!["index"]!.GetValue<int>()].Location = PrimitiveAccess.Point(v["point"]);
        if (r["newName"] is not null) target.Name = CivilObjectAccess.Text(r, "newName");
        if (r["lockToStation"] is not null) target.LockToStation = r["lockToStation"]!.GetValue<bool>();
        return new { handle = target.Handle.ToString(), state = State(target) };
    }
}

