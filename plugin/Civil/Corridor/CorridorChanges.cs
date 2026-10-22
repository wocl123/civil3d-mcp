using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using CivilAssembly = Autodesk.Civil.DatabaseServices.Assembly;

namespace MyCivil3DMcp.Plugin;

internal static class CorridorChanges
{
    internal static IEnumerable<T> Objects<T>(Database db, Transaction tr) where T : Autodesk.Civil.DatabaseServices.Entity
    {
        CivilDocument civil = CivilDocument.GetCivilDocument(db);
        IEnumerable<ObjectId> ids = typeof(T) == typeof(Corridor) ? civil.CorridorCollection.Cast<ObjectId>()
            : typeof(T) == typeof(CivilAssembly) ? civil.AssemblyCollection.Cast<ObjectId>() : civil.SubassemblyCollection.Cast<ObjectId>();
        return ids.Select(i => tr.GetObject(i, OpenMode.ForRead)).OfType<T>();
    }
    internal static JsonObject State(Corridor c) => new() { ["name"] = c.Name, ["description"] = c.Description,
        ["layer"] = c.Layer, ["automatic"] = c.RebuildAutomatic,
        ["baselines"] = new JsonArray(c.Baselines.Select(b => (JsonNode)new JsonObject { ["name"] = b.Name,
            ["start"] = b.StartStation, ["end"] = b.EndStation,
            ["regions"] = new JsonArray(b.BaselineRegions.Select(g => (JsonNode)new JsonObject {
                ["name"] = g.Name, ["start"] = g.StartStation, ["end"] = g.EndStation,
                ["assembly"] = g.AssemblyId.Handle.ToString(),
                ["tangentFrequency"] = g.AppliedAssemblySetting.FrequencyAlongTangents,
                ["curveFrequency"] = g.AppliedAssemblySetting.FrequencyAlongCurves,
                ["targets"] = new JsonArray(g.GetTargets().Select(t => (JsonNode)new JsonObject { ["logicalName"] = t.LogicalName,
                    ["subassembly"] = t.SubassemblyName, ["type"] = t.TargetType.ToString(),
                    ["ids"] = new JsonArray(t.TargetIds.Cast<ObjectId>().Select(i => JsonValue.Create(i.Handle.ToString())).ToArray()) }).ToArray()) }).ToArray()) }).ToArray()) };

    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        if (CivilObjectAccess.Text(r, "kind") == "subassemblies")
        {
            var allSubassemblies = Objects<Subassembly>(doc.Database, tr).ToArray();
            return new { total = allSubassemblies.Length, offset, items = allSubassemblies.Skip(offset).Take(limit).Select(a => new {
                name = a.Name, handle = a.Handle.ToString(), a.Description, parameters = CorridorEditing.Parameters(a) }).ToArray(), hasMore = offset + limit < allSubassemblies.Length };
        }
        object[] all = CivilObjectAccess.Text(r, "kind") switch
        {
            "corridors" => Objects<Corridor>(doc.Database, tr).Select(c => (object)new { name = c.Name, handle = c.Handle.ToString(),
                state = State(c), pointCodes = c.GetPointCodes(), linkCodes = c.GetLinkCodes(), shapeCodes = c.GetShapeCodes(),
                surfaces = c.CorridorSurfaces.Select(s => new { s.Name, handle = s.SurfaceId.Handle.ToString(), links = s.LinkCodes() }).ToArray() }).ToArray(),
            "assemblies" => Objects<CivilAssembly>(doc.Database, tr).Select(a => (object)new { name = a.Name,
                handle = a.Handle.ToString(), position = PrimitiveAccess.JsonPoint(a.Location), a.Description }).ToArray(),
            "subassemblies" => Objects<Subassembly>(doc.Database, tr).Select(a => (object)new { name = a.Name, handle = a.Handle.ToString(), a.Description,
                parameters = CorridorEditing.Parameters(a) }).ToArray(),
            _ => throw new ArgumentException("알 수 없는 코리더 조회 종류입니다.")
        };
        return new { total = all.Length, offset, items = all.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < all.Length };
    }

    private static void BaselineInputs(Database db, Transaction tr, JsonObject r)
    {
        if (r["featureLine"] is not null)
        {
            if (r["alignment"] is not null || r["profile"] is not null || r["assembly"] is not null)
                throw new ArgumentException("형상선 기준선은 선형·종단과 함께 지정하지 않습니다. 구간은 기준선 생성 후 별도로 지정하세요.");
            FeatureLine feature = FeatureLineChanges.Find<FeatureLine>(db, tr, CivilObjectAccess.Text(r, "featureLine"));
            CorridorEditing.Guard(db, tr, feature); r["featureLine"] = feature.Handle.ToString();
            r["featureState"] = feature.ComputeFingerPrint().ToString("X"); CivilObjectAccess.Text(r, "baselineName"); return;
        }
        Alignment alignment = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment"));
        Profile profile = CivilObjectAccess.Find<Profile>(tr, db, CivilObjectAccess.Text(r, "profile"));
        if (profile.AlignmentId != alignment.ObjectId) throw new ArgumentException("종단과 기준 선형이 일치하지 않습니다.");
        CivilObjectAccess.Editable(alignment); CivilObjectAccess.Editable(profile);
        r["alignment"] = alignment.Handle.ToString(); r["profile"] = profile.Handle.ToString();
        if (r["assembly"] is not null)
        {
            CivilAssembly assembly = SectionChanges.Find(Objects<CivilAssembly>(db, tr), CivilObjectAccess.Text(r, "assembly"));
            CivilObjectAccess.Editable(assembly); PrimitiveAccess.Writable(db, tr, assembly);
            r["assembly"] = assembly.Handle.ToString();
            double from = CivilObjectAccess.Number(r["startStation"]), to = CivilObjectAccess.Number(r["endStation"]);
            if (from < Math.Max(alignment.StartingStation, profile.StartingStation) || to > Math.Min(alignment.EndingStation, profile.EndingStation) || from >= to)
                throw new ArgumentException("코리더 구간은 선형·종단의 공통 측점 범위 안에 지정하세요.");
            CivilObjectAccess.Text(r, "regionName");
        }
        CivilObjectAccess.Text(r, "baselineName");
    }

    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "assembly.create")
        {
            string name = CivilObjectAccess.Text(r, "name");
            if (Objects<CivilAssembly>(db, tr).Any(a => a.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 표준횡단 이름이 있습니다.");
            PrimitiveAccess.Point(r["position"]); PrimitiveAccess.Layer(db, tr, r);
            details.Add("빈 표준횡단을 생성합니다. 설계 횡단 형상은 서브어셈블리를 연결해야 합니다.");
        }
        else if (op == "assembly.edit")
        {
            var a = SectionChanges.Find(Objects<CivilAssembly>(db, tr), CivilObjectAccess.Text(r, "assembly"));
            CivilObjectAccess.Editable(a); PrimitiveAccess.Writable(db, tr, a);
            r["assembly"] = a.Handle.ToString(); details.Add($"{a.Name} [{a.Handle}], 위치 {PrimitiveAccess.PointText(a.Location)}");
            if (r["position"] is null && r["subassembly"] is null) throw new ArgumentException("위치 또는 연결할 서브어셈블리를 지정하세요.");
            if (r["position"] is not null) PrimitiveAccess.Point(r["position"]);
            if (r["subassembly"] is not null)
            {
                var s = SectionChanges.Find(Objects<Subassembly>(db, tr), CivilObjectAccess.Text(r, "subassembly"));
                CivilObjectAccess.Editable(s); PrimitiveAccess.Writable(db, tr, s); r["subassembly"] = s.Handle.ToString();
            }
        }
        else if (op == "corridor.create")
        {
            string name = CivilObjectAccess.Text(r, "name");
            if (Objects<Corridor>(db, tr).Any(c => c.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 코리더 이름이 있습니다.");
            BaselineInputs(db, tr, r); PrimitiveAccess.Layer(db, tr, r);
        }
        else
        {
            Corridor c = SectionChanges.Find(Objects<Corridor>(db, tr), CivilObjectAccess.Text(r, "corridor"));
            CivilObjectAccess.Editable(c); PrimitiveAccess.Writable(db, tr, c);
            r["corridor"] = c.Handle.ToString(); r["sourceState"] = State(c);
            details.Add($"코리더 {c.Name} [{c.Handle}]: 관련 지표면·횡단이 갱신될 수 있습니다.");
            if (op == "corridor.baseline")
            {
                BaselineInputs(db, tr, r);
                if (c.Baselines.Any(b => b.Name.Equals(CivilObjectAccess.Text(r, "baselineName"), StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 기준선 이름이 있습니다.");
            }
            else if (op == "corridor.region")
            {
                Baseline b = c.Baselines.SingleOrDefault(b => b.Name == CivilObjectAccess.Text(r, "baselineName")) ?? throw new ArgumentException("기준선이 없습니다.");
                string regionName = CivilObjectAccess.Text(r, "regionName");
                if (r["assembly"] is not null)
                {
                    var a = SectionChanges.Find(Objects<CivilAssembly>(db, tr), CivilObjectAccess.Text(r, "assembly"));
                    r["assembly"] = a.Handle.ToString();
                }
                BaselineRegion? existing = b.BaselineRegions.SingleOrDefault(g => g.Name == regionName);
                double from = r["startStation"] is null ? existing?.StartStation ?? double.NaN : CivilObjectAccess.Number(r["startStation"]);
                double to = r["endStation"] is null ? existing?.EndStation ?? double.NaN : CivilObjectAccess.Number(r["endStation"]);
                if (!double.IsFinite(from) || !double.IsFinite(to) || from >= to || from < b.StartStation || to > b.EndStation)
                    throw new ArgumentException("구간 측점은 기준선 범위 안에 지정하세요.");
                if (existing is null && r["assembly"] is null) throw new ArgumentException("새 구간의 표준횡단이 필요합니다.");
                if (b.BaselineRegions.Any(g => g != existing && from < g.EndStation - 1e-9 && to > g.StartStation + 1e-9)) throw new ArgumentException("기존 코리더 구간과 겹칩니다.");
                foreach (string key in new[] { "frequency", "curveFrequency", "spiralFrequency", "profileFrequency" })
                    if (r[key] is not null && CivilObjectAccess.Number(r[key]) <= 0) throw new ArgumentException("적용 간격은 양수여야 합니다.");
                if (r["targets"] is JsonArray targets)
                {
                    if (existing is null) throw new ArgumentException("타깃은 구간 생성 후 별도 계획으로 지정하세요.");
                    foreach (JsonNode? item in targets)
                    {
                        var matches = existing.GetTargets().Where(t => t.LogicalName == item!["logicalName"]!.ToString() && t.SubassemblyName == item["subassembly"]!.ToString()).ToArray();
                        if (matches.Length != 1) throw new ArgumentException("구간에 유일하게 일치하는 타깃이 없습니다. 코리더 상세를 먼저 조회하세요.");
                        foreach (JsonNode? h in (JsonArray)item!["handles"]!)
                        {
                            var entity = CivilObjectAccess.ByHandle(tr, db, h!.ToString());
                            if (entity is not (Autodesk.Civil.DatabaseServices.Surface or Alignment or Profile or FeatureLine or Polyline or Polyline3d)) throw new ArgumentException("지원하지 않는 타깃 객체입니다.");
                        }
                    }
                }
            }
            else if (op == "corridor.surface")
            {
                string name = CivilObjectAccess.Text(r, "name");
                if (c.CorridorSurfaces.Any(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("코리더 지표면 이름이 이미 있습니다.");
                if (r["linkCodes"] is not JsonArray codes || codes.Count == 0) throw new ArgumentException("지표면에 사용할 링크 코드를 지정하세요.");
                foreach (JsonNode? code in codes) if (!c.GetLinkCodes().Contains(code!.ToString())) throw new ArgumentException("코리더에 없는 링크 코드입니다.");
                CivilObjectAccess.Style(tr, db, "surface", r["style"]?.ToString());
            }
            else if (op != "corridor.rebuild") throw new ArgumentException("알 수 없는 코리더 작업입니다.");
        }
        details.AddRange(CivilPlanDetails.Describe(r));
        return CivilPlanDetails.Title(op);
    }

    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        CivilDocument civil = CivilDocument.GetCivilDocument(db);
        if (op is "assembly.create" or "assembly.edit")
        {
            ObjectId id = op == "assembly.create" ? civil.AssemblyCollection.Add(CivilObjectAccess.Text(r, "name"), AssemblyType.Other, PrimitiveAccess.Point(r["position"]))
                : SectionChanges.Find(Objects<CivilAssembly>(db, tr), CivilObjectAccess.Text(r, "assembly")).ObjectId;
            var a = (CivilAssembly)tr.GetObject(id, OpenMode.ForWrite);
            if (r["layer"] is not null) a.LayerId = PrimitiveAccess.Layer(db, tr, r);
            if (r["position"] is not null) a.Location = PrimitiveAccess.Point(r["position"]);
            if (r["subassembly"] is not null) a.AddSubassembly(SectionChanges.Find(Objects<Subassembly>(db, tr), CivilObjectAccess.Text(r, "subassembly")).ObjectId);
            return new { name = a.Name, handle = a.Handle.ToString() };
        }
        Corridor c;
        if (op == "corridor.create")
        {
            ObjectId id = civil.CorridorCollection.Add(CivilObjectAccess.Text(r, "name"));
            c = (Corridor)tr.GetObject(id, OpenMode.ForWrite); c.RebuildAutomatic = false;
            c.LayerId = PrimitiveAccess.Layer(db, tr, r);
        }
        else { c = SectionChanges.Find(Objects<Corridor>(db, tr), CivilObjectAccess.Text(r, "corridor")); c.UpgradeOpen(); }
        if (op is "corridor.create" or "corridor.baseline")
        {
            Baseline b = r["featureLine"] is not null ? c.Baselines.Add(CivilObjectAccess.Text(r, "baselineName"), FeatureLineChanges.Find<FeatureLine>(db, tr, CivilObjectAccess.Text(r, "featureLine")).ObjectId)
                : c.Baselines.Add(CivilObjectAccess.Text(r, "baselineName"), CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment")).ObjectId,
                    CivilObjectAccess.Find<Profile>(tr, db, CivilObjectAccess.Text(r, "profile")).ObjectId);
            if (r["assembly"] is not null) b.BaselineRegions.Add(CivilObjectAccess.Text(r, "regionName"),
                SectionChanges.Find(Objects<CivilAssembly>(db, tr), CivilObjectAccess.Text(r, "assembly")).ObjectId,
                CivilObjectAccess.Number(r["startStation"]), CivilObjectAccess.Number(r["endStation"]));
        }
        else if (op == "corridor.region")
        {
            Baseline b = c.Baselines.Single(b => b.Name == CivilObjectAccess.Text(r, "baselineName"));
            BaselineRegion? g = b.BaselineRegions.SingleOrDefault(g => g.Name == CivilObjectAccess.Text(r, "regionName"));
            if (g is null) g = b.BaselineRegions.Add(CivilObjectAccess.Text(r, "regionName"), SectionChanges.Find(Objects<CivilAssembly>(db, tr), CivilObjectAccess.Text(r, "assembly")).ObjectId,
                CivilObjectAccess.Number(r["startStation"]), CivilObjectAccess.Number(r["endStation"]));
            else
            {
                if (r["assembly"] is not null) g.AssemblyId = SectionChanges.Find(Objects<CivilAssembly>(db, tr), CivilObjectAccess.Text(r, "assembly")).ObjectId;
                if (r["startStation"] is not null && CivilObjectAccess.Number(r["startStation"]) >= g.EndStation) g.EndStation = CivilObjectAccess.Number(r["endStation"]);
                if (r["startStation"] is not null) g.StartStation = CivilObjectAccess.Number(r["startStation"]);
                if (r["endStation"] is not null) g.EndStation = CivilObjectAccess.Number(r["endStation"]);
            }
            if (r["frequency"] is not null) g.AppliedAssemblySetting.FrequencyAlongTangents = CivilObjectAccess.Number(r["frequency"]);
            if (r["curveFrequency"] is not null) g.AppliedAssemblySetting.FrequencyAlongCurves = CivilObjectAccess.Number(r["curveFrequency"]);
            if (r["spiralFrequency"] is not null) g.AppliedAssemblySetting.FrequencyAlongSpirals = CivilObjectAccess.Number(r["spiralFrequency"]);
            if (r["profileFrequency"] is not null) g.AppliedAssemblySetting.FrequencyAlongProfileCurves = CivilObjectAccess.Number(r["profileFrequency"]);
            if (r["targets"] is JsonArray targets)
            {
                var settings = g.GetTargets();
                foreach (JsonNode? item in targets)
                {
                    var target = settings.Single(t => t.LogicalName == item!["logicalName"]!.ToString() && t.SubassemblyName == item["subassembly"]!.ToString());
                    target.TargetIds = new ObjectIdCollection(((JsonArray)item!["handles"]!).Select(h => CivilObjectAccess.ByHandle(tr, db, h!.ToString()).ObjectId).ToArray());
                }
                g.SetTargets(settings);
            }
        }
        else if (op == "corridor.surface")
        {
            var surface = c.CorridorSurfaces.Add(CivilObjectAccess.Text(r, "name"), CivilObjectAccess.Style(tr, db, "surface", r["style"]?.ToString()));
            foreach (JsonNode? code in (JsonArray)r["linkCodes"]!) surface.AddLinkCode(code!.ToString(), false);
            surface.IsBuild = true;
        }
        c.Rebuild();
        return new { name = c.Name, handle = c.Handle.ToString(), state = State(c) };
    }
}
