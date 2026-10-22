using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace MyCivil3DMcp.Plugin;

internal static class PressureRunChanges
{
    private static PressurePipeNetwork Network(Database db, Transaction tr, string key) => SectionChanges.Find(
        CivilDocument.GetCivilDocument(db).GetPressurePipeNetworkIds().Cast<ObjectId>().Select(id => (PressurePipeNetwork)tr.GetObject(id, OpenMode.ForRead)), key);
    private static JsonObject State(PressurePipeRun run) => new() { ["name"] = run.Name, ["alignment"] = run.AlignmentId.Handle.ToString(),
        ["parts"] = new JsonArray(run.GetPartIds().Cast<ObjectId>().Select(id => JsonValue.Create(id.Handle.ToString())).ToArray()) };
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        var n = Network(doc.Database, tr, CivilObjectAccess.Text(r, "network"));
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        var runs = n.PipeRuns.ToArray();
        return new { total = runs.Length, offset, items = runs.Skip(offset).Take(limit).Select(State).ToArray(), hasMore = offset + limit < runs.Length };
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        var n = Network(db, tr, CivilObjectAccess.Text(r, "network")); r["network"] = n.Handle.ToString();
        JsonObject guard = new() { ["operation"] = "pressureNetwork.edit", ["network"] = n.Handle.ToString(), ["description"] = n.Description };
        PressureChanges.Validate(db, tr, guard, new List<string>());
        r["networkState"] = guard;
        r["runsState"] = new JsonArray(n.PipeRuns.Select(run => (JsonNode)State(run)).ToArray());
        r["pathStates"] = new JsonArray(n.PipeRuns.Select(run => (JsonNode)new JsonObject {
            ["alignment"] = ((Alignment)tr.GetObject(run.AlignmentId, OpenMode.ForRead)).ComputeFingerPrint().ToString("X"),
            ["profiles"] = new JsonArray(((Alignment)tr.GetObject(run.AlignmentId, OpenMode.ForRead)).GetProfileIds().Cast<ObjectId>()
                .Select(id => (JsonNode)new JsonObject { ["handle"] = id.Handle.ToString(), ["fingerprint"] = ((Profile)tr.GetObject(id, OpenMode.ForRead)).ComputeFingerPrint().ToString("X") }).ToArray()) }).ToArray());
        foreach (var run in n.PipeRuns) CorridorEditing.Guard(db, tr, (Alignment)tr.GetObject(run.AlignmentId, OpenMode.ForRead));
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "pressureRun.create")
        {
            string name = CivilObjectAccess.Text(r, "name");
            if (n.PipeRuns.Any(run => run.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 관로 런 이름이 있습니다.");
            var path = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source")) as Polyline ?? throw new ArgumentException("열린 XY 경량 폴리선을 지정하세요.");
            PrimitiveAccess.Writable(db, tr, path);
            if (path.Closed || path.NumberOfVertices < 2 || path.NumberOfVertices > 200 || path.Length <= 1e-9 || !path.Normal.IsEqualTo(Vector3d.ZAxis)) throw new ArgumentException("열린 XY 경량 폴리선(2~200 정점)이 필요합니다.");
            if (Enumerable.Range(0, path.NumberOfVertices).Any(i => Math.Abs(path.GetBulgeAt(i)) > 1e-9)) throw new ArgumentException("관로 런은 현재 직선 세그먼트 폴리선만 지원합니다.");
            if (CivilObjectAccess.Number(r["cover"]) <= 0) throw new ArgumentException("토피는 양수입니다.");
            if (n.PartsListId.IsNull) throw new ArgumentException("압력관망 부품 목록이 필요합니다.");
            var list = (PressurePartList)tr.GetObject(n.PartsListId, OpenMode.ForRead);
            var size = list.GetPart(CivilObjectAccess.Text(r, "sizeGuid"));
            if (size is null || !size.IsValid || size.Domain != PressurePartDomainType.Pipe) throw new ArgumentException("카탈로그의 실제 Pipe 규격 GUID를 지정하세요.");
            foreach (ObjectId layer in new[] { n.PipePlanLayerId, n.FittingPlanLayerId, n.AppurtenancePlanLayerId }) CivilObjectAccess.WritableLayer(tr, layer);
            r["source"] = path.Handle.ToString(); r["pathState"] = GeometryEditing.Snapshot(path);
            details.Add("원본 폴리선을 보존하고 카탈로그 규격의 경로 기반 관로를 생성합니다. 토피·경로 Z 및 실제 기준 지표면을 확인하세요.");
        }
        else
        {
            var run = n.PipeRuns.SingleOrDefault(run => run.Name == CivilObjectAccess.Text(r, "run")) ?? throw new ArgumentException("관로 런이 없습니다.");
            if (op == "pressureRun.delete")
            {
                if (r["removeParts"] is null || r["removePath"] is null) throw new ArgumentException("부품 삭제와 경로 삭제 여부를 각각 명시하세요.");
                bool parts = r["removeParts"]!.GetValue<bool>(), path = r["removePath"]!.GetValue<bool>();
                var a = (Alignment)tr.GetObject(run.AlignmentId, OpenMode.ForRead);
                if (path && (a.GetProfileViewIds().Count > 0 || a.GetSampleLineGroupIds().Count > 0
                    || a.GetProfileIds().Cast<ObjectId>().Any(id => id != run.ProfileId))) throw new ArgumentException("경로 선형에 별도 종단·횡단·뷰가 있습니다. 경로 보존 옵션을 사용하세요.");
                if (path && CorridorChanges.Objects<Corridor>(db, tr).Any(c => c.Baselines.Any(b => !b.IsFeatureLineBased() && b.AlignmentId == a.ObjectId)))
                    throw new ArgumentException("경로 선형을 사용하는 코리더가 있습니다.");
                HashSet<ObjectId> owned = run.GetPartIds().Cast<ObjectId>().ToHashSet();
                if (parts) foreach (ObjectId id in owned)
                {
                    var part = (PressurePart)tr.GetObject(id, OpenMode.ForRead);
                    for (int i = 0; i < part.ConnectionCount; i++)
                    { using var connection = part.GetConnectionAt(i); if (!connection.Open && !owned.Contains(connection.ConnectedId)) throw new ArgumentException("런 밖 부품과 연결돼 있어 삭제할 수 없습니다. 연결을 먼저 해제하세요."); }
                }
                details.Add($"관로 런 {run.Name} 삭제: 소속 부품 {owned.Count}개 {(parts ? "삭제" : "보존")}, 경로 선형 {(path ? "삭제" : "보존")}.");
            }
            else if (op == "pressureRun.break")
            {
                string name = CivilObjectAccess.Text(r, "newName");
                if (n.PipeRuns.Any(v => v.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("새 관로 런 이름이 중복됩니다.");
                Point3d p = PrimitiveAccess.Point(r["point"]); var a = (Alignment)tr.GetObject(run.AlignmentId, OpenMode.ForRead);
                double station = 0, offset = 0; a.StationOffset(p.X, p.Y, ref station, ref offset);
                if (Math.Abs(offset) > 1e-6 || station <= a.StartingStation + 1e-6 || station >= a.EndingStation - 1e-6) throw new ArgumentException("분할점은 경로 내부의 정확한 XY 위치여야 합니다.");
            }
            else if (op == "pressureRun.merge")
            {
                var other = n.PipeRuns.SingleOrDefault(v => v.Name == CivilObjectAccess.Text(r, "otherRun")) ?? throw new ArgumentException("상대 관로 런이 없습니다.");
                if (other.Name == run.Name) throw new ArgumentException("다른 관로 런을 지정하세요.");
                details.Add("두 런을 첫 번째 런으로 병합합니다. Civil 3D가 연결 형상을 거부하면 전체 변경을 롤백합니다.");
            }
            else if (op == "pressureRun.profile")
            {
                Profile p = CivilObjectAccess.Find<Profile>(tr, db, CivilObjectAccess.Text(r, "profile")); CorridorEditing.Guard(db, tr, p);
                if (p.AlignmentId != run.AlignmentId) throw new ArgumentException("해당 관로 런의 경로 선형에 속한 종단을 지정하세요.");
                r["profile"] = p.Handle.ToString(); r["profileState"] = p.ComputeFingerPrint().ToString("X");
                CivilObjectAccess.Number(r["verticalOffset"]); r["keepFollow"]!.GetValue<bool>();
            }
            else throw new ArgumentException("지원하지 않는 관로 런 작업입니다.");
        }
        details.AddRange(CivilPlanDetails.Describe(r)); return CivilPlanDetails.Title(op);
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var n = Network(db, tr, CivilObjectAccess.Text(r, "network")); n.UpgradeOpen();
        foreach (PressurePipeRun existing in n.PipeRuns) tr.GetObject(existing.AlignmentId, OpenMode.ForWrite);
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "pressureRun.create")
        {
            var path = (Polyline)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source"));
            var list = (PressurePartList)tr.GetObject(n.PartsListId, OpenMode.ForRead);
            using Polyline copy = (Polyline)path.Clone();
            n.PipeRuns.createPipeRun(CivilObjectAccess.Text(r, "name"), copy, list.GetPart(CivilObjectAccess.Text(r, "sizeGuid")), CivilObjectAccess.Number(r["cover"]), r["autoAddBends"]?.GetValue<bool>() ?? false);
        }
        else
        {
            var run = n.PipeRuns.Single(v => v.Name == CivilObjectAccess.Text(r, "run"));
            if (op == "pressureRun.delete") n.PipeRuns.Remove(run, r["removeParts"]!.GetValue<bool>(), r["removePath"]!.GetValue<bool>());
            else if (op == "pressureRun.break") { Point3d p = PrimitiveAccess.Point(r["point"]); run.Break(new Point2d(p.X, p.Y), CivilObjectAccess.Text(r, "newName")); }
            else if (op == "pressureRun.merge") run.Merge(n.PipeRuns.Single(v => v.Name == CivilObjectAccess.Text(r, "otherRun")));
            else run.FollowProfile(CivilObjectAccess.Find<Profile>(tr, db, CivilObjectAccess.Text(r, "profile")).ObjectId, CivilObjectAccess.Number(r["verticalOffset"]), r["keepFollow"]!.GetValue<bool>());
        }
        return new { network = n.Handle.ToString(), runs = n.PipeRuns.Select(State).ToArray() };
    }
}
