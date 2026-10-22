using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace MyCivil3DMcp.Plugin;

internal static class PressureChanges
{
    private static IEnumerable<PressurePipeNetwork> Networks(Database db, Transaction tr) =>
        CivilDocument.GetCivilDocument(db).GetPressurePipeNetworkIds().Cast<ObjectId>().Select(i => (PressurePipeNetwork)tr.GetObject(i, OpenMode.ForRead));
    private static IEnumerable<PressurePart> Parts(PressurePipeNetwork network, Transaction tr) => network.GetPipeIds().Cast<ObjectId>()
        .Concat(network.GetFittingIds().Cast<ObjectId>()).Concat(network.GetAppurtenanceIds().Cast<ObjectId>())
        .Select(i => (PressurePart)tr.GetObject(i, OpenMode.ForRead));
    private static PressurePartList Catalog(Database db, Transaction tr, string key)
    {
        var all = PressurePartList.GetAvailablePartLists(db).Cast<ObjectId>().Select(i => (PressurePartList)tr.GetObject(i, OpenMode.ForRead)).ToArray();
        var found = all.Where(p => p.Handle.ToString().Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (found.Length == 0) found = all.Where(p => p.Name.Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        return found.Length == 1 ? found[0] : throw new ArgumentException("압력관 부품 목록이 없거나 이름이 중복됩니다.");
    }
    private static JsonObject State(PressurePart p) => new() { ["handle"] = p.Handle.ToString(), ["name"] = p.Name,
        ["fingerprint"] = p.ComputeFingerPrint().ToString("X"),
        ["description"] = p.Description, ["layer"] = p.Layer, ["family"] = p.PartFamilyName,
        ["position"] = PrimitiveAccess.JsonPoint(p.Position),
        ["start"] = p is PressurePipe pipe ? PrimitiveAccess.JsonPoint(pipe.StartPoint) : null,
        ["end"] = p is PressurePipe pipe2 ? PrimitiveAccess.JsonPoint(pipe2.EndPoint) : null,
        ["connections"] = new JsonArray(Enumerable.Range(0, p.ConnectionCount).Select(i => {
            using var c = p.GetConnectionAt(i);
            return (JsonNode)new JsonObject { ["port"] = i, ["open"] = c.Open, ["connected"] = c.ConnectedId.IsNull ? null : c.ConnectedId.Handle.ToString(),
                ["connectedPort"] = c.ConnectedIndex, ["position"] = PrimitiveAccess.JsonPoint(c.Position) };
        }).ToArray()) };

    public static object List(Document doc, JsonObject r)
    {
        Database db = doc.Database;
        using Transaction tr = db.TransactionManager.StartTransaction();
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        object[] all;
        if (r["catalog"]?.GetValue<bool>() == true)
        {
            if (r["partsList"] is null)
                all = PressurePartList.GetAvailablePartLists(db).Cast<ObjectId>().Select(i => (PressurePartList)tr.GetObject(i, OpenMode.ForRead))
                    .Select(p => (object)new { name = p.Name, handle = p.Handle.ToString() }).ToArray();
            else
                all = Enum.GetValues<PressurePartDomainType>().SelectMany(d => Catalog(db, tr, CivilObjectAccess.Text(r, "partsList")).GetParts(d))
                    .DistinctBy(p => p.PartSizeGuid).Select(p => (object)new { guid = p.PartSizeGuid, familyGuid = p.FamilyGuid,
                        description = p.Description, domain = p.Domain.ToString(), type = p.PartType.ToString() }).ToArray();
        }
        else if (r["network"] is not null)
            all = Parts(SectionChanges.Find(Networks(db, tr), CivilObjectAccess.Text(r, "network")), tr).Select(p => (object)State(p)).ToArray();
        else all = Networks(db, tr).Select(n => (object)new { name = n.Name, handle = n.Handle.ToString(),
            partsList = n.PartsListId.IsNull ? null : n.PartsListName, pipes = n.GetPipeIds().Count, fittings = n.GetFittingIds().Count, appurtenances = n.GetAppurtenanceIds().Count }).ToArray();
        return new { total = all.Length, offset, items = all.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < all.Length };
    }

    private static PressurePartSize Size(Database db, Transaction tr, JsonObject r, PressurePipeNetwork n)
    {
        if (n.PartsListId.IsNull) throw new ArgumentException("압력관망에 부품 목록을 먼저 지정하세요.");
        PressurePartList list = (PressurePartList)tr.GetObject(n.PartsListId, OpenMode.ForRead);
        string guid = CivilObjectAccess.Text(r, "sizeGuid");
        PressurePartSize part = list.GetPart(guid);
        if (part is null || !part.IsValid) throw new ArgumentException("부품 목록에 없는 규격 GUID입니다.");
        return part;
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "pressureNetwork.create")
        {
            string name = CivilObjectAccess.Text(r, "name");
            if (Networks(db, tr).Any(n => n.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 압력관망 이름이 있습니다.");
            if (r["partsList"] is not null) r["partsList"] = Catalog(db, tr, CivilObjectAccess.Text(r, "partsList")).Handle.ToString();
            PrimitiveAccess.Layer(db, tr, r);
            details.Add("빈 압력관망 생성. 중력식 관망과 별도 객체입니다.");
        }
        else
        {
            PressurePart? target = null;
            PressurePipeNetwork n;
            if (op == "pressurePart.edit")
            {
                target = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")) as PressurePart ?? throw new ArgumentException("압력관 부품 핸들을 지정하세요.");
                n = (PressurePipeNetwork)tr.GetObject(target.NetworkId, OpenMode.ForRead);
            }
            else n = SectionChanges.Find(Networks(db, tr), CivilObjectAccess.Text(r, "network"));
            CivilObjectAccess.Editable(n); CivilObjectAccess.WritableLayer(tr, n.LayerId);
            r["network"] = n.Handle.ToString();
            PressurePart[] parts = Parts(n, tr).Take(1001).ToArray();
            if (parts.Length > 1000) throw new ArgumentException("압력관망 검증 범위 1000개를 초과했습니다.");
            foreach (var p in parts) { CivilObjectAccess.Editable(p); PrimitiveAccess.Writable(db, tr, p); }
            Queue<Autodesk.AutoCAD.DatabaseServices.Entity> graph = new(parts.Cast<Autodesk.AutoCAD.DatabaseServices.Entity>().Prepend(n));
            HashSet<ObjectId> visited = new(); JsonArray labels = new();
            while (graph.TryDequeue(out var owner))
            {
                if (!visited.Add(owner.ObjectId)) continue;
                if (visited.Count > 1000) throw new ArgumentException("압력관망·연결 라벨 검증 범위 1000개를 초과했습니다.");
                foreach (ObjectId id in owner.GetPersistentReactorIds())
                    if (!id.IsNull && !id.IsErased && !visited.Contains(id) && tr.GetObject(id, OpenMode.ForRead) is Autodesk.AutoCAD.DatabaseServices.Entity dependent
                        && (dependent.GetType().Name.Contains("Label", StringComparison.Ordinal) || dependent.GetType().Name.Contains("Pressure", StringComparison.Ordinal)))
                    {
                        CivilObjectAccess.WritableLayer(tr, dependent.LayerId);
                        if (dependent is Autodesk.Civil.DatabaseServices.Entity civil) CivilObjectAccess.Editable(civil);
                        graph.Enqueue(dependent);
                        labels.Add(new JsonObject { ["handle"] = dependent.Handle.ToString(), ["layer"] = dependent.Layer });
                    }
            }
            r["connectedState"] = labels;
            r["sourceState"] = new JsonObject { ["name"] = n.Name, ["fingerprint"] = n.ComputeFingerPrint().ToString("X"), ["partsList"] = n.PartsListId.IsNull ? null : n.PartsListId.Handle.ToString(),
                ["parts"] = new JsonArray(parts.Select(State).ToArray()) };
            if (r["newName"] is not null)
            {
                string name = CivilObjectAccess.Text(r, "newName"); SymbolUtilityServices.ValidateSymbolName(name, false);
                if (op == "pressureNetwork.edit" && Networks(db, tr).Any(e => e.ObjectId != n.ObjectId && e.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("압력관망 이름이 중복됩니다.");
                if (target is not null && parts.Any(e => e.ObjectId != target.ObjectId && e.Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("압력관 부품 이름이 중복됩니다.");
            }
            if (op == "pressureNetwork.edit")
            {
                if (r["newName"] is null && r["description"] is null && r["partsList"] is null) throw new ArgumentException("변경할 속성을 지정하세요.");
                if (r["partsList"] is not null && !n.IsEmpty) throw new ArgumentException("부품 목록은 빈 압력관망에서만 변경합니다.");
                if (r["partsList"] is not null) r["partsList"] = Catalog(db, tr, CivilObjectAccess.Text(r, "partsList")).Handle.ToString();
            }
            else if (op == "pressurePart.create")
            {
                PressurePartSize size = Size(db, tr, r, n);
                string kind = CivilObjectAccess.Text(r, "kind");
                if (!size.Domain.ToString().Equals(kind, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("부품 도메인과 생성 종류가 다릅니다. 카탈로그를 조회하세요.");
                ObjectId destinationLayer = kind == "Pipe" ? n.PipePlanLayerId : kind == "Fitting" ? n.FittingPlanLayerId : n.AppurtenancePlanLayerId;
                CivilObjectAccess.WritableLayer(tr, destinationLayer);
                if (parts.Any(p => p.Name.Equals(CivilObjectAccess.Text(r, "name"), StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("부품 이름이 중복됩니다.");
                if (kind == "Pipe")
                {
                    var start = PrimitiveAccess.Point(r["start"]); var end = PrimitiveAccess.Point(r["end"]);
                    if (start.DistanceTo(end) < 1e-9) throw new ArgumentException("관의 시작과 끝이 같을 수 없습니다.");
                    if (r["midPoint"] is not null)
                    {
                        Point3d mid = PrimitiveAccess.Point(r["midPoint"]);
                        if (Math.Abs(mid.Z - start.Z) > 1e-8 || Math.Abs(end.Z - start.Z) > 1e-8) throw new ArgumentException("세 점 압력 곡선관은 같은 WCS 표고의 세 점으로 지정하세요.");
                        double cross = (mid.X - start.X) * (end.Y - start.Y) - (mid.Y - start.Y) * (end.X - start.X);
                        if (Math.Abs(cross) < 1e-8) throw new ArgumentException("곡선 통과점은 시작·끝과 일직선일 수 없습니다.");
                    }
                }
                else PrimitiveAccess.Point(r["position"]);
                details.Add($"실제 부품 {size.Description} [{size.PartSizeGuid}]");
            }
            else if (op == "pressurePart.edit")
            {
                if (!new[] { "newName", "description", "position", "start", "end", "sizeGuid", "connectPipe", "disconnectPort", "layer" }.Any(k => r[k] is not null)) throw new ArgumentException("변경할 압력관 부품 속성을 지정하세요.");
                if (new[] { "position", "start", "end", "sizeGuid" }.Any(k => r[k] is not null)
                    && Enumerable.Range(0, target!.ConnectionCount).Any(i => !target.GetConnectionAt(i).Open))
                    throw new ArgumentException("연결된 부품의 위치·규격을 변경하려면 각 포트를 별도 계획에서 먼저 해제하세요.");
                if (r["sizeGuid"] is not null && Size(db, tr, r, n).Domain != target!.PartDomain) throw new ArgumentException("다른 도메인의 부품으로 교체할 수 없습니다.");
                if (r["start"] is not null || r["end"] is not null)
                {
                    if (target is not PressurePipe pipe || pipe.IsCurve || pipe.HasVerticalSegments) throw new ArgumentException("단순 직선 압력관만 끝점을 편집합니다.");
                    if (r["start"] is not null) PrimitiveAccess.Point(r["start"]);
                    if (r["end"] is not null) PrimitiveAccess.Point(r["end"]);
                }
                if (r["position"] is not null) PrimitiveAccess.Point(r["position"]);
                if (r["connectPipe"] is not null || r["disconnectPort"] is not null)
                {
                    int port = r["port"]?.GetValue<int>() ?? r["disconnectPort"]?.GetValue<int>() ?? -1;
                    if (port < 0 || port >= target!.ConnectionCount) throw new ArgumentException("연결 포트 인덱스 범위를 확인하세요.");
                    if (r["connectPipe"] is not null)
                    {
                        var pipe = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "connectPipe")) as PressurePipe ?? throw new ArgumentException("연결할 압력관을 지정하세요.");
                        if (pipe.NetworkId != n.ObjectId || pipe.ObjectId == target.ObjectId) throw new ArgumentException("같은 압력관망의 다른 관만 연결합니다.");
                        int pipePort = r["pipePort"]?.GetValue<int>() ?? -1;
                        if (pipePort is < 0 or > 1) throw new ArgumentException("관의 포트는 0 또는 1입니다.");
                        using var a = target.GetConnectionAt(port); using var b = pipe.GetConnectionAt(pipePort);
                        if (!a.Open || !b.Open) throw new ArgumentException("기존 연결을 먼저 명시적으로 해제하세요.");
                        if (a.Position.DistanceTo(b.Position) > 1e-5) throw new ArgumentException("연결할 포트의 WCS 위치가 일치하지 않습니다.");
                    }
                }
            }
            else throw new ArgumentException("알 수 없는 압력관망 작업입니다.");
            if (r["layer"] is not null) PrimitiveAccess.Layer(db, tr, r);
            details.Add($"압력관망 {n.Name}: 연결 부품·종단 표시가 갱신될 수 있습니다.");
        }
        details.AddRange(CivilPlanDetails.Describe(r));
        return CivilPlanDetails.Title(op);
    }

    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        PressurePipeNetwork n;
        if (op == "pressureNetwork.create")
        {
            n = (PressurePipeNetwork)tr.GetObject(PressurePipeNetwork.Create(db, CivilObjectAccess.Text(r, "name")), OpenMode.ForWrite);
            ObjectId layer = PrimitiveAccess.Layer(db, tr, r);
            n.PipePlanLayerId = layer; n.FittingPlanLayerId = layer; n.AppurtenancePlanLayerId = layer;
        }
        else { n = SectionChanges.Find(Networks(db, tr), CivilObjectAccess.Text(r, "network")); n.UpgradeOpen(); }
        if (r["partsList"] is not null) n.PartsListId = Catalog(db, tr, CivilObjectAccess.Text(r, "partsList")).ObjectId;
        if (op is "pressureNetwork.create" or "pressureNetwork.edit")
        {
            if (r["newName"] is not null) n.Name = CivilObjectAccess.Text(r, "newName");
            if (r["description"] is not null) n.Description = r["description"]!.ToString();
            if (r["layer"] is not null) n.LayerId = PrimitiveAccess.Layer(db, tr, r);
            return new { name = n.Name, handle = n.Handle.ToString() };
        }
        PressurePart p;
        if (op == "pressurePart.create")
        {
            var size = Size(db, tr, r, n);
            ObjectId id = CivilObjectAccess.Text(r, "kind") switch {
                "Pipe" => CreatePipe(n, r, size),
                "Fitting" => n.AddFitting(PrimitiveAccess.Point(r["position"]), size),
                "Appurtenance" => n.AddAppurtenance(PrimitiveAccess.Point(r["position"]), size),
                _ => throw new ArgumentException("알 수 없는 압력관 부품 종류입니다.") };
            p = (PressurePart)tr.GetObject(id, OpenMode.ForWrite); p.Name = CivilObjectAccess.Text(r, "name");
        }
        else { p = (PressurePart)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")); p.UpgradeOpen(); }
        if (r["newName"] is not null) p.Name = CivilObjectAccess.Text(r, "newName");
        if (r["description"] is not null) p.Description = r["description"]!.ToString();
        if (r["layer"] is not null) p.LayerId = PrimitiveAccess.Layer(db, tr, r);
        if (r["position"] is not null && op != "pressurePart.create") p.Position = PrimitiveAccess.Point(r["position"]);
        if (p is PressurePipe pipe && op == "pressurePart.edit")
        {
            if (r["start"] is not null) pipe.StartPoint = PrimitiveAccess.Point(r["start"]);
            if (r["end"] is not null) pipe.EndPoint = PrimitiveAccess.Point(r["end"]);
        }
        if (r["sizeGuid"] is not null && op == "pressurePart.edit") p.SwapPartSize(Size(db, tr, r, n));
        if (r["disconnectPort"] is not null) p.DisconnectAt(r["disconnectPort"]!.GetValue<int>());
        if (r["connectPipe"] is not null)
        {
            var other = (PressurePipe)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "connectPipe")); other.UpgradeOpen();
            p.ConnectToPipe(r["port"]!.GetValue<int>(), other.ObjectId, r["pipePort"]!.GetValue<int>());
        }
        return State(p);
    }
    private static ObjectId CreatePipe(PressurePipeNetwork network, JsonObject r, PressurePartSize size)
    {
        Point3d start = PrimitiveAccess.Point(r["start"]), end = PrimitiveAccess.Point(r["end"]);
        if (r["midPoint"] is null)
        {
            using LineSegment3d line = new(start, end);
            return network.AddLinePipe(line, size);
        }
        Point3d mid = PrimitiveAccess.Point(r["midPoint"]);
        using PipeCurveGeometry curve = new(start, new Point2d(mid.X, mid.Y), end);
        return network.AddCurvePipe(curve, size);
    }
}
