using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using CivilEntity = Autodesk.Civil.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

internal static class CivilObjectDeletion
{
    private static bool Match(CivilEntity e, string kind) => kind switch {
        "featureLine" => e is FeatureLine, "sampleLine" => e is SampleLine, "sampleGroup" => e is SampleLineGroup,
        "sectionView" => e is SectionView, "catchment" => e is Catchment, "pressurePart" => e is PressurePart, _ => false };
    private static bool ParentOrSource(CivilEntity item, ObjectId id) => item switch {
        SampleLine line => line.GroupId == id, SampleLineGroup group => group.ParentAlignmentId == id,
        SectionView view => view.SampleLineId == id, PressurePart part => part.NetworkId == id,
        Catchment catchment => catchment.ReferenceSurfaceId == id || catchment.ReferencePipeNetworkStructureId == id,
        FeatureLine feature => feature.RelativeSurfaceId == id, _ => false };
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string kind = CivilObjectAccess.Text(r, "kind");
        if (r["handles"] is not JsonArray handles || handles.Count is < 1 or > 200) throw new ArgumentException("대상 핸들 1~200개를 지정하세요.");
        HashSet<ObjectId> roots = handles.Select(h => CivilObjectAccess.ByHandle(tr, db, h!.ToString()).ObjectId).ToHashSet();
        Dictionary<ObjectId, CivilEntity> erase = new();
        bool include = r["includeDependents"]?.GetValue<bool>() ?? false;
        void Add(ObjectId id)
        {
            if (id.IsNull || id.IsErased || erase.ContainsKey(id)) return;
            if (tr.GetObject(id, OpenMode.ForRead) is not CivilEntity e) throw new ArgumentException("Civil 객체만 삭제합니다.");
            CorridorEditing.Guard(db, tr, e); erase[id] = e;
            if (erase.Count > 2000) throw new ArgumentException("종속 객체 삭제 범위 2000개를 초과합니다.");
        }
        foreach (ObjectId id in roots)
        {
            var e = (CivilEntity)tr.GetObject(id, OpenMode.ForRead);
            if (!Match(e, kind)) throw new ArgumentException("삭제 종류와 대상 형식이 다릅니다.");
            Add(id);
            if (e is SampleLine lineParent) { var group = (SampleLineGroup)tr.GetObject(lineParent.GroupId, OpenMode.ForRead); CorridorEditing.Guard(db, tr, group); CorridorEditing.Guard(db, tr, (Alignment)tr.GetObject(group.ParentAlignmentId, OpenMode.ForRead)); }
            if (e is SampleLineGroup groupParent) CorridorEditing.Guard(db, tr, (Alignment)tr.GetObject(groupParent.ParentAlignmentId, OpenMode.ForRead));
            if (e is SampleLineGroup g)
            {
                foreach (ObjectId line in g.GetSampleLineIds())
                {
                    if (!include) throw new ArgumentException("추출선이 있는 그룹은 종속 객체 포함을 명시하세요.");
                    Add(line);
                }
            }
        }
        foreach (var line in erase.Values.OfType<SampleLine>().ToArray())
            foreach (ObjectId id in line.GetSectionIds().Cast<ObjectId>().Concat(line.GetSectionViewIds().Cast<ObjectId>()))
            {
                if (!include && !roots.Contains(id)) throw new ArgumentException("관련 횡단·횡단뷰 삭제를 포함해야 합니다."); Add(id);
            }
        foreach (var e in erase.Values.ToArray())
        {
            if (e is FeatureLine feature)
            {
                if (!feature.SiteId.IsNull) throw new ArgumentException("Site 소속 형상선은 정지·위상 관계를 확인해야 합니다. 원본 Civil 3D에서 처리하세요.");
                foreach (Corridor c in CorridorChanges.Objects<Corridor>(db, tr))
                    if (c.Baselines.Any(b => (b.IsFeatureLineBased() && b.FeatureLineId == e.ObjectId)
                        || b.BaselineRegions.Any(region => region.GetTargets().Any(t => t.TargetIds.Contains(e.ObjectId)))))
                        throw new ArgumentException($"형상선을 사용하는 코리더 {c.Name}가 있습니다.");
                var points = feature.GetPoints(FeatureLinePointType.AllPoints).Cast<Autodesk.AutoCAD.Geometry.Point3d>().ToArray();
                if (points.Length > 1000) throw new ArgumentException("형상선 삭제 검증은 최대 1000개 점입니다.");
                int checkedPoints = 0;
                foreach (TinSurface surface in CivilObjectAccess.All<TinSurface>(tr, db))
                    for (int opIndex = 0; opIndex < surface.BreaklinesDefinition.Count; opIndex++)
                    {
                        SurfaceOperationAddBreakline operation = surface.BreaklinesDefinition[opIndex];
                        foreach (SurfaceBreakline line in operation)
                        {
                            var vertices = line.Vertices; checkedPoints += vertices.Count;
                            if (checkedPoints > 10000) throw new ArgumentException("브레이크라인 종속성 검증 범위를 초과했습니다. Civil 3D에서 연결을 확인하세요.");
                            if (vertices.Cast<Autodesk.AutoCAD.Geometry.Point3d>().Any(p => points.Any(q => p.DistanceTo(q) < 1e-6)))
                                throw new ArgumentException($"지표면 {surface.Name}의 브레이크라인과 형상이 겹칩니다. 원본 연결 확인 후 처리하세요.");
                        }
                    }
            }
            if (e is PressurePart part)
            {
                var network = (PressurePipeNetwork)tr.GetObject(part.NetworkId, OpenMode.ForRead);
                JsonObject guard = new() { ["operation"] = "pressureNetwork.edit", ["network"] = network.Handle.ToString(), ["description"] = network.Description };
                PressureChanges.Validate(db, tr, guard, new List<string>()); r["network_" + network.Handle] = guard;
                if (network.PipeRuns.Any(run => run.GetPartIds().Contains(e.ObjectId))) throw new ArgumentException("관로 런 소속 부품은 런 단위 삭제를 사용하세요.");
                for (int port = 0; port < part.ConnectionCount; port++)
                {
                    using var connection = part.GetConnectionAt(port);
                    if (!connection.Open && !erase.ContainsKey(connection.ConnectedId))
                        throw new ArgumentException("다른 부품에 연결돼 있습니다. 연결 해제 또는 연결된 부품 전체를 명시하세요.");
                }
            }
            foreach (ObjectId id in e.GetPersistentReactorIds())
                if (!id.IsNull && !id.IsErased && !erase.ContainsKey(id)
                    && tr.GetObject(id, OpenMode.ForRead) is CivilEntity dependent && !ParentOrSource(e, id))
                    throw new ArgumentException($"외부 종속 객체 {dependent.GetType().Name} [{dependent.Handle}]가 있습니다. 자동 연쇄 삭제하지 않습니다.");
        }
        r["deleteState"] = new JsonArray(erase.Values.OrderBy(e => e.Handle.Value).Select(e => (JsonNode)new JsonObject {
            ["handle"] = e.Handle.ToString(), ["kind"] = e.GetType().Name, ["name"] = e.Name, ["fingerprint"] = e.ComputeFingerPrint().ToString("X"), ["layer"] = e.Layer }).ToArray());
        foreach (var e in erase.Values) details.Add($"삭제: {e.GetType().Name} {e.Name} [{e.Handle}]");
        return $"Civil 객체 {erase.Count}개 삭제";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var nodes = ((JsonArray)r["deleteState"]!).OfType<JsonObject>().ToArray();
        int Order(JsonObject n) => n["kind"]!.ToString() switch { "SectionView" => 0, "Section" => 1, "SampleLine" => 2, "SampleLineGroup" => 3, _ => 0 };
        foreach (JsonObject node in nodes.OrderBy(Order))
        {
            string handle = node["handle"]!.ToString();
            if (db.TryGetObjectId(new Handle(Convert.ToInt64(handle, 16)), out ObjectId id) && !id.IsErased)
                tr.GetObject(id, OpenMode.ForWrite).Erase();
        }
        return new { deleted = nodes.Select(n => n["handle"]!.ToString()).ToArray() };
    }
}
