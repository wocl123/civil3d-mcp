using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace MyCivil3DMcp.Plugin;

internal static class CivilUtilityChanges
{
    private static IEnumerable<PointGroup> Groups(Database db, Transaction tr) => CivilDocument.GetCivilDocument(db).PointGroups
        .Cast<ObjectId>().Select(i => (PointGroup)tr.GetObject(i, OpenMode.ForRead));
    private static IEnumerable<Site> Sites(Database db, Transaction tr) => CivilDocument.GetCivilDocument(db).GetSiteIds()
        .Cast<ObjectId>().Select(i => (Site)tr.GetObject(i, OpenMode.ForRead));
    private static PointGroup Group(Database db, Transaction tr, string key)
    {
        PointGroup[] all = Groups(db, tr).ToArray();
        PointGroup[] found = all.Where(g => g.Handle.ToString().Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (found.Length == 0) found = all.Where(g => g.Name.Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        return found.Length == 1 ? found[0] : throw new ArgumentException("점 그룹 대상이 없거나 이름이 중복됩니다.");
    }
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        object[] items = CivilObjectAccess.Text(r, "kind") switch
        {
            "pointGroups" => Groups(doc.Database, tr).Select(g => (object)new { name = g.Name, handle = g.Handle.ToString(),
                g.Description, pointCount = g.GetPointNumbers().Length, numbers = g.GetPointNumbers().Take(100).ToArray(),
                numbersTruncated = g.GetPointNumbers().Length > 100 }).ToArray(),
            "sites" => Sites(doc.Database, tr).Select(s => (object)new { name = s.Name, handle = s.Handle.ToString(), s.Description }).ToArray(),
            _ => throw new ArgumentException("알 수 없는 조회 종류입니다.")
        };
        return new { total = items.Length, offset, items = items.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < items.Length };
    }

    public static object SampleSurface(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        TinSurface s = CivilObjectAccess.Find<TinSurface>(tr, doc.Database, CivilObjectAccess.Text(r, "surface"));
        if (r["points"] is not JsonArray points || points.Count is < 1 or > 1000) throw new ArgumentException("조회할 XY 위치 1~1000개를 지정하세요.");
        return new { surface = s.Name, handle = s.Handle.ToString(), units = CivilCoordinates.Read(doc.Database),
            items = points.Select(p => {
                double x = CivilObjectAccess.Number(p?["x"]), y = CivilObjectAccess.Number(p?["y"]);
                try { return (object)new { x, y, elevation = s.FindElevationAtXY(x, y), slope = s.FindSlopeAtXY(x, y), inside = true }; }
                catch (Autodesk.Civil.PointNotOnEntityException) { return new { x, y, inside = false }; }
            }).ToArray() };
    }

    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op is "site.create" or "pointGroup.create")
        {
            string name = CivilObjectAccess.Text(r, "name");
            SymbolUtilityServices.ValidateSymbolName(name, false);
            bool exists = op == "site.create" ? Sites(db, tr).Any(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
                : Groups(db, tr).Any(g => g.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (exists) throw new ArgumentException("같은 이름이 이미 있습니다.");
            details.Add($"{op}: {name}");
        }
        if (op == "pointGroup.edit")
        {
            PointGroup g = Group(db, tr, CivilObjectAccess.Text(r, "group"));
            if (g.ObjectId == CivilDocument.GetCivilDocument(db).PointGroups.AllPointsPointGroupId) throw new ArgumentException("전체 점 기본 그룹의 쿼리는 변경하지 않습니다.");
            r["group"] = g.Handle.ToString();
            r["sourceState"] = JsonSerializer.SerializeToNode(new { g.Name, g.Description, numbers = g.GetPointNumbers(),
                query = JsonSerializer.SerializeToNode(g.GetQuery(), g.GetQuery().GetType()) });
            if (r["query"] is null) throw new ArgumentException("교체할 점 그룹 쿼리가 필요합니다.");
        }
        if (op is "pointGroup.create" or "pointGroup.edit")
        {
            if (r["query"] is not JsonObject q) throw new ArgumentException("명시적 점 그룹 쿼리를 지정하세요.");
            MakeQuery(q);
            details.Add("점 포함/제외 쿼리 전체를 지정한 조건으로 설정하고 그룹을 갱신합니다. 표시 우선순위와 스타일 재정의는 보존합니다.");
        }
        else if (op == "site.edit")
        {
            Site s = SectionChanges.Find(Sites(db, tr), CivilObjectAccess.Text(r, "site"));
            CivilObjectAccess.Editable(s); CivilObjectAccess.WritableLayer(tr, s.LayerId);
            r["site"] = s.Handle.ToString(); details.Add($"{s.Name} [{s.Handle}] {s.Description}");
            if (r["newName"] is null && r["description"] is null) throw new ArgumentException("변경할 부지 이름·설명을 지정하세요.");
            if (r["newName"] is not null && Sites(db, tr).Any(e => e.ObjectId != s.ObjectId && e.Name.Equals(r["newName"]!.ToString(), StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 부지 이름이 있습니다.");
        }
        else if (op == "style.copy")
        {
            string kind = CivilObjectAccess.Text(r, "kind");
            ObjectId source = CivilObjectAccess.Style(tr, db, kind, CivilObjectAccess.Text(r, "style"));
            string name = CivilObjectAccess.Text(r, "name");
            SymbolUtilityServices.ValidateSymbolName(name, false);
            if (CivilObjectAccess.StyleIds(db, kind).Any(i => ((StyleBase)tr.GetObject(i, OpenMode.ForRead)).Name.Equals(name, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("같은 스타일 이름이 있습니다.");
            r["style"] = source.Handle.ToString();
            details.Add($"스타일 {((StyleBase)tr.GetObject(source, OpenMode.ForRead)).Name} 복제 → {name}");
        }
        else if (op == "cogo.delete")
        {
            CogoPoint[] points = PrimitiveAccess.Targets<CogoPoint>(db, tr, r).Cast<CogoPoint>().ToArray();
            foreach (CogoPoint p in points)
                if (p.IsLocked || p.IsSurveyPoint || p.IsProjectPoint || !p.IsMovable) throw new ArgumentException("잠금·측량·프로젝트 점은 삭제하지 않습니다.");
            r["sourceState"] = JsonSerializer.SerializeToNode(points.Select(p => new { p.PointNumber, p.Easting, p.Northing, p.Elevation, p.RawDescription }));
            details.Add($"COGO 점 {points.Length}개 삭제. 점 그룹과 이 점을 사용하는 지표면이 갱신될 수 있습니다.");
        }
        else if (op == "alignment.offset")
        {
            Alignment a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment"));
            CivilObjectAccess.Editable(a); PrimitiveAccess.Writable(db, tr, a); r["alignment"] = a.Handle.ToString();
            CivilObjectAccess.FreeName<Alignment>(tr, db, CivilObjectAccess.Text(r, "name"));
            if (Math.Abs(CivilObjectAccess.Number(r["offset"])) < 1e-9) throw new ArgumentException("오프셋은 0일 수 없습니다.");
            if (r["startStation"] is not null || r["endStation"] is not null)
                if (CivilObjectAccess.Number(r["startStation"]) < a.StartingStation || CivilObjectAccess.Number(r["endStation"]) > a.EndingStation || CivilObjectAccess.Number(r["startStation"]) >= CivilObjectAccess.Number(r["endStation"])) throw new ArgumentException("오프셋 선형 측점 범위를 확인하세요.");
            CivilObjectAccess.Style(tr, db, "alignment", r["style"]?.ToString());
            PrimitiveAccess.Layer(db, tr, r); details.Add($"기준 선형 {a.Name}의 동적 오프셋 선형 생성: {r["offset"]}");
        }
        else if (op is "profile.pvi" or "profileView.range")
        {
            if (op == "profile.pvi")
            {
                Profile p = CivilObjectAccess.Find<Profile>(tr, db, CivilObjectAccess.Text(r, "profile"));
                CivilObjectAccess.Editable(p); PrimitiveAccess.Writable(db, tr, p); r["profile"] = p.Handle.ToString();
                if (p.ProfileType != ProfileType.FG) throw new ArgumentException("설계 종단의 PVI만 편집합니다.");
                r["sourceState"] = JsonSerializer.SerializeToNode(p.PVIs.Select(v => new { station = v.RawStation, v.Elevation }));
                string action = CivilObjectAccess.Text(r, "action");
                if (action is not ("add" or "edit" or "delete")) throw new ArgumentException("PVI 작업을 지정하세요.");
                if (action != "add")
                {
                    int index = r["index"]?.GetValue<int>() ?? -1;
                    if (index < 0 || index >= p.PVIs.Count) throw new ArgumentException("PVI 인덱스 범위가 잘못됐습니다.");
                    if (action == "delete" && (index == 0 || index == p.PVIs.Count - 1)) throw new ArgumentException("종단 양 끝 PVI는 삭제하지 않습니다.");
                }
                if (action != "delete")
                {
                    double station = CivilObjectAccess.Number(r["station"]); CivilObjectAccess.Number(r["elevation"]);
                    Alignment a = (Alignment)tr.GetObject(p.AlignmentId, OpenMode.ForRead);
                    if (station < a.StartingStation || station > a.EndingStation) throw new ArgumentException("PVI 측점이 선형 범위를 벗어났습니다.");
                    if (p.PVIs.Select((v, i) => (v, i)).Any(e => (action == "add" || e.i != r["index"]!.GetValue<int>()) && Math.Abs(e.v.RawStation - station) < 1e-8)) throw new ArgumentException("같은 측점의 PVI가 있습니다.");
                }
                details.Add("개별 PVI 편집: 연결 접선과 종곡선이 갱신됩니다. 전체 종단 교체는 하지 않습니다.");
            }
            else
            {
                ProfileView v = CivilObjectAccess.Find<ProfileView>(tr, db, CivilObjectAccess.Text(r, "profileView"));
                CivilObjectAccess.Editable(v); PrimitiveAccess.Writable(db, tr, v); r["profileView"] = v.Handle.ToString();
                details.Add($"종단뷰 {v.Name} [{v.Handle}], 표고 {v.ElevationMin}~{v.ElevationMax}, 측점 {v.StationStart}~{v.StationEnd}");
                if (r["stationStart"] is null && r["elevationMin"] is null) throw new ArgumentException("변경할 범위를 지정하세요.");
                foreach (var pair in new[] { ("stationStart", "stationEnd"), ("elevationMin", "elevationMax") })
                    if (r[pair.Item1] is not null || r[pair.Item2] is not null)
                        if (CivilObjectAccess.Number(r[pair.Item1]) >= CivilObjectAccess.Number(r[pair.Item2])) throw new ArgumentException("표시 범위를 확인하세요.");
            }
        }
        else if (op != "site.create" && op != "pointGroup.create" && op != "pointGroup.edit") throw new ArgumentException("알 수 없는 Civil 편집입니다.");
        details.AddRange(CivilPlanDetails.Describe(r));
        return CivilPlanDetails.Title(op);
    }

    private static StandardPointGroupQuery MakeQuery(JsonObject q) => new() {
        IncludeAllPoints = q["all"]?.GetValue<bool>() ?? false,
        IncludeNumbers = q["includeNumbers"]?.ToString() ?? "", ExcludeNumbers = q["excludeNumbers"]?.ToString() ?? "",
        IncludeRawDescriptions = q["includeDescriptions"]?.ToString() ?? "", ExcludeRawDescriptions = q["excludeDescriptions"]?.ToString() ?? "",
        IncludeElevations = q["includeElevations"]?.ToString() ?? "", ExcludeElevations = q["excludeElevations"]?.ToString() ?? "" };

    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        CivilDocument civil = CivilDocument.GetCivilDocument(db);
        ObjectId id;
        switch (op)
        {
            case "pointGroup.create": case "pointGroup.edit":
                id = op == "pointGroup.create" ? civil.PointGroups.Add(CivilObjectAccess.Text(r, "name")) : Group(db, tr, CivilObjectAccess.Text(r, "group")).ObjectId;
                PointGroup g = (PointGroup)tr.GetObject(id, OpenMode.ForWrite); g.SetQuery(MakeQuery((JsonObject)r["query"]!)); g.Update(); break;
            case "site.create": id = Site.Create(civil, CivilObjectAccess.Text(r, "name")); break;
            case "site.edit":
                Site s = SectionChanges.Find(Sites(db, tr), CivilObjectAccess.Text(r, "site")); s.UpgradeOpen(); id = s.ObjectId;
                if (r["newName"] is not null) s.Name = CivilObjectAccess.Text(r, "newName");
                if (r["description"] is not null) s.Description = r["description"]!.ToString(); break;
            case "style.copy":
                StyleBase style = (StyleBase)tr.GetObject(CivilObjectAccess.Style(tr, db, CivilObjectAccess.Text(r, "kind"), CivilObjectAccess.Text(r, "style")), OpenMode.ForWrite);
                id = style.CopyAsSibling(CivilObjectAccess.Text(r, "name")); break;
            case "cogo.delete": return new { deleted = PrimitiveAccess.Erase(db, tr, r) };
            case "alignment.offset":
                Alignment a = CivilObjectAccess.Find<Alignment>(tr, db, CivilObjectAccess.Text(r, "alignment"));
                id = Alignment.CreateOffsetAlignment(CivilObjectAccess.Text(r, "name"), a.ObjectId, CivilObjectAccess.Number(r["offset"]), CivilObjectAccess.Style(tr, db, "alignment", r["style"]?.ToString()),
                    r["startStation"] is null ? a.StartingStation : CivilObjectAccess.Number(r["startStation"]), r["endStation"] is null ? a.EndingStation : CivilObjectAccess.Number(r["endStation"]));
                ((Alignment)tr.GetObject(id, OpenMode.ForWrite)).LayerId = PrimitiveAccess.Layer(db, tr, r); break;
            case "profile.pvi":
                Profile p = CivilObjectAccess.Find<Profile>(tr, db, CivilObjectAccess.Text(r, "profile")); p.UpgradeOpen(); id = p.ObjectId;
                string action = CivilObjectAccess.Text(r, "action");
                if (action == "delete") p.PVIs.RemoveAt(r["index"]!.GetValue<int>());
                else if (action == "add") p.PVIs.AddPVI(CivilObjectAccess.Number(r["station"]), CivilObjectAccess.Number(r["elevation"]));
                else { var v = p.PVIs[r["index"]!.GetValue<int>()]; v.RawStation = CivilObjectAccess.Number(r["station"]); v.Elevation = CivilObjectAccess.Number(r["elevation"]); }
                break;
            case "profileView.range":
                ProfileView view = CivilObjectAccess.Find<ProfileView>(tr, db, CivilObjectAccess.Text(r, "profileView")); view.UpgradeOpen(); id = view.ObjectId;
                if (r["elevationMin"] is not null)
                {
                    view.ElevationRangeMode = ElevationRangeType.UserSpecified;
                    double min = CivilObjectAccess.Number(r["elevationMin"]), max = CivilObjectAccess.Number(r["elevationMax"]);
                    if (min >= view.ElevationMax) view.ElevationMax = max;
                    view.ElevationMin = min; view.ElevationMax = max;
                }
                if (r["stationStart"] is not null)
                {
                    view.StationRangeMode = StationRangeType.UserSpecified;
                    double min = CivilObjectAccess.Number(r["stationStart"]), max = CivilObjectAccess.Number(r["stationEnd"]);
                    if (min >= view.StationEnd) view.StationEnd = max;
                    view.StationStart = min; view.StationEnd = max;
                }
                break;
            default: throw new ArgumentException("알 수 없는 Civil 편집입니다.");
        }
        return new { handle = id.Handle.ToString(), operation = op };
    }
}
