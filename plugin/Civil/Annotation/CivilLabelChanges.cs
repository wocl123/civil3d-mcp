using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace MyCivil3DMcp.Plugin;

internal static class CivilLabelChanges
{
    private static bool? Flip(Label label)
    {
        try { return label.Flipped; }
        catch (InvalidOperationException) { return null; }
        catch (NotSupportedException) { return null; }
    }
    public static object List(Document doc, int offset, int limit)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        Label[] all = PrimitiveAccess.Entities(doc.Database, tr, true).OfType<Label>().ToArray();
        return new { total = all.Length, offset, items = all.Skip(offset).Take(limit).Select(l => new {
            handle = l.Handle.ToString(), type = l.GetType().Name, style = l.StyleName, layer = l.Layer,
            position = PrimitiveAccess.JsonPoint(l.LabelLocation), pinned = l.Pinned,
            components = l.GetTextComponentIds().Cast<ObjectId>().Select(i => new { handle = i.Handle.ToString(),
                textOverride = l.IsTextComponentOverriden(i) ? l.GetTextComponentOverride(i) : null }).ToArray() }).ToArray(), hasMore = offset + limit < all.Length };
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "label.create")
        {
            string kind = CivilObjectAccess.Text(r, "kind");
            if (kind is "surfaceElevation" or "surfaceSlope")
            {
                TinSurface s = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface"));
                r["surface"] = s.Handle.ToString();
                var p = PrimitiveAccess.Point(r["position"]); s.FindElevationAtXY(p.X, p.Y);
                if (r["secondPoint"] is not null) { var q = PrimitiveAccess.Point(r["secondPoint"]); s.FindElevationAtXY(q.X, q.Y); }
                if (r["style"] is not null) CivilObjectAccess.Style(tr, db, kind == "surfaceElevation" ? "surfaceElevationLabel" : "surfaceSlopeLabel", r["style"]!.ToString());
            }
            else if (kind == "segment")
            {
                var source = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source"));
                if (source is not (Line or Arc or Polyline or Circle)) throw new ArgumentException("일반 선·호·폴리선·원의 구간 라벨만 만듭니다.");
                double ratio = CivilObjectAccess.Number(r["ratio"]);
                if (ratio < 0 || source is Polyline p && ratio > p.NumberOfVertices - (p.Closed ? 0 : 1) || source is not Polyline && ratio > 1) throw new ArgumentException("일반 구간 비율은 0~1, 폴리선은 세그먼트 인덱스+비율입니다.");
                r["sourceState"] = GeometryEditing.Snapshot(source);
                if (r["lineStyle"] is not null) CivilObjectAccess.Style(tr, db, "generalLineLabel", r["lineStyle"]!.ToString());
                if (r["curveStyle"] is not null) CivilObjectAccess.Style(tr, db, "generalCurveLabel", r["curveStyle"]!.ToString());
                if ((r["lineStyle"] is null) != (r["curveStyle"] is null)) throw new ArgumentException("선·곡선 라벨 스타일을 함께 지정하세요.");
            }
            else if (kind == "note")
            {
                PrimitiveAccess.Point(r["position"]);
                if (r["style"] is not null) CivilObjectAccess.Style(tr, db, "noteLabel", r["style"]!.ToString());
            }
            else throw new ArgumentException("알 수 없는 라벨 종류입니다.");
            if (r["markerStyle"] is not null) CivilObjectAccess.Style(tr, db, "marker", r["markerStyle"]!.ToString());
            PrimitiveAccess.Layer(db, tr, r);
        }
        else if (op is "label.edit" or "label.delete")
        {
            var label = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")) as Label ?? throw new ArgumentException("개별 Civil 라벨 핸들을 지정하세요.");
            CivilObjectAccess.Editable(label); PrimitiveAccess.Writable(db, tr, label);
            r["sourceState"] = new JsonObject { ["location"] = PrimitiveAccess.JsonPoint(label.LabelLocation), ["pinned"] = label.Pinned,
                ["style"] = label.StyleId.Handle.ToString(), ["flipped"] = Flip(label),
                ["overrides"] = new JsonArray(label.GetTextComponentIds().Cast<ObjectId>().Select(i => (JsonNode)new JsonObject {
                    ["handle"] = i.Handle.ToString(), ["value"] = label.IsTextComponentOverriden(i) ? label.GetTextComponentOverride(i) : null }).ToArray()) };
            if (op == "label.edit")
            {
                if (!new[] { "position", "rotationDegrees", "pinned", "flipped", "overrides", "clearOverrides" }.Any(k => r[k] is not null)) throw new ArgumentException("변경할 라벨 속성을 지정하세요.");
                if (r["position"] is not null) { PrimitiveAccess.Point(r["position"]); if (label.Pinned && r["pinned"]?.GetValue<bool>() != false) throw new ArgumentException("고정 라벨을 이동하려면 pinned=false를 명시하세요."); }
                if (r["rotationDegrees"] is not null && !label.CanRotate) throw new ArgumentException("회전할 수 없는 라벨입니다.");
                if (r["flipped"] is not null && Flip(label) is null) throw new ArgumentException("뒤집기를 지원하지 않는 라벨 종류입니다.");
                if (r["overrides"] is JsonArray overrides)
                    foreach (JsonNode? item in overrides)
                        if (!label.GetTextComponentIds().Cast<ObjectId>().Any(i => i.Handle.ToString().Equals(item?["component"]?.ToString(), StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("라벨에 없는 문자 구성요소입니다.");
            }
            details.Add($"{label.GetType().Name} [{label.Handle}], 스타일 {label.StyleName}, 레이어 {label.Layer}");
        }
        else if (op == "style.text")
        {
            ObjectId id = CivilObjectAccess.Style(tr, db, CivilObjectAccess.Text(r, "styleKind"), CivilObjectAccess.Text(r, "style"));
            LabelStyle style = tr.GetObject(id, OpenMode.ForRead) as LabelStyle ?? throw new ArgumentException("라벨 스타일만 문자 구성요소를 수정합니다.");
            ObjectId componentId = style.GetComponents(LabelStyleComponentType.Text).Cast<ObjectId>().SingleOrDefault(i => i.Handle.ToString().Equals(CivilObjectAccess.Text(r, "component"), StringComparison.OrdinalIgnoreCase));
            if (componentId.IsNull) throw new ArgumentException("스타일에 없는 문자 구성요소입니다.");
            var component = (LabelStyleTextComponent)tr.GetObject(componentId, OpenMode.ForRead);
            if (r["contents"] is null && r["height"] is null) throw new ArgumentException("문자 내용 또는 높이를 지정하세요.");
            if (r["height"] is not null && CivilObjectAccess.Number(r["height"]) <= 0) throw new ArgumentException("문자 높이는 양수입니다.");
            r["sourceState"] = new JsonObject { ["contents"] = component.Text.Contents.Value, ["height"] = component.Text.Height.Value };
            details.Add($"스타일 {style.Name}의 문자 구성요소 {componentId.Handle} 수정. 이 스타일을 쓰는 모든 라벨에 영향을 줍니다.");
        }
        else throw new ArgumentException("알 수 없는 라벨 작업입니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return CivilPlanDetails.Title(op);
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "style.text")
        {
            var style = (LabelStyle)tr.GetObject(CivilObjectAccess.Style(tr, db, CivilObjectAccess.Text(r, "styleKind"), CivilObjectAccess.Text(r, "style")), OpenMode.ForWrite);
            ObjectId componentId = style.GetComponents(LabelStyleComponentType.Text).Cast<ObjectId>().Single(i => i.Handle.ToString().Equals(CivilObjectAccess.Text(r, "component"), StringComparison.OrdinalIgnoreCase));
            var component = (LabelStyleTextComponent)tr.GetObject(componentId, OpenMode.ForWrite);
            if (r["contents"] is not null) component.Text.Contents.Value = r["contents"]!.ToString();
            if (r["height"] is not null) component.Text.Height.Value = CivilObjectAccess.Number(r["height"]);
            return new { handle = style.Handle.ToString() };
        }
        ObjectId id;
        if (op == "label.create")
        {
            string kind = CivilObjectAccess.Text(r, "kind");
            if (kind == "segment")
            {
                var source = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source")); source.UpgradeOpen();
                id = r["lineStyle"] is null ? GeneralSegmentLabel.Create(source.ObjectId, CivilObjectAccess.Number(r["ratio"]))
                    : GeneralSegmentLabel.Create(source.ObjectId, CivilObjectAccess.Number(r["ratio"]), CivilObjectAccess.Style(tr, db, "generalLineLabel", r["lineStyle"]!.ToString()), CivilObjectAccess.Style(tr, db, "generalCurveLabel", r["curveStyle"]!.ToString()));
            }
            else
            {
                Point3d p = PrimitiveAccess.Point(r["position"]);
                if (kind == "note") id = r["style"] is null ? NoteLabel.Create(db, p) : NoteLabel.Create(p, CivilObjectAccess.Style(tr, db, "noteLabel", r["style"]!.ToString()), CivilObjectAccess.Style(tr, db, "marker", r["markerStyle"]?.ToString()));
                else
                {
                    var s = CivilObjectAccess.Find<TinSurface>(tr, db, CivilObjectAccess.Text(r, "surface")); s.UpgradeOpen();
                    Point2d xy = new(p.X, p.Y);
                    if (kind == "surfaceElevation") id = r["style"] is null ? SurfaceElevationLabel.Create(s.ObjectId, xy) : SurfaceElevationLabel.Create(s.ObjectId, xy, CivilObjectAccess.Style(tr, db, "surfaceElevationLabel", r["style"]!.ToString()), CivilObjectAccess.Style(tr, db, "marker", r["markerStyle"]?.ToString()));
                    else if (r["secondPoint"] is not null)
                    {
                        var q = PrimitiveAccess.Point(r["secondPoint"]); Point2d xy2 = new(q.X, q.Y);
                        id = r["style"] is null ? SurfaceSlopeLabel.Create(s.ObjectId, xy, xy2) : SurfaceSlopeLabel.Create(s.ObjectId, xy, xy2, CivilObjectAccess.Style(tr, db, "surfaceSlopeLabel", r["style"]!.ToString()));
                    }
                    else id = r["style"] is null ? SurfaceSlopeLabel.Create(s.ObjectId, xy) : SurfaceSlopeLabel.Create(s.ObjectId, xy, CivilObjectAccess.Style(tr, db, "surfaceSlopeLabel", r["style"]!.ToString()));
                }
            }
            ((Label)tr.GetObject(id, OpenMode.ForWrite)).LayerId = PrimitiveAccess.Layer(db, tr, r);
        }
        else
        {
            Label label = (Label)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")); label.UpgradeOpen(); id = label.ObjectId;
            if (op == "label.delete") label.Erase();
            else
            {
                if (r["pinned"] is not null) label.Pinned = r["pinned"]!.GetValue<bool>();
                if (r["position"] is not null) label.LabelLocation = PrimitiveAccess.Point(r["position"]);
                if (r["flipped"] is not null) label.Flipped = r["flipped"]!.GetValue<bool>();
                if (r["rotationDegrees"] is not null) label.RotationAngle = CivilObjectAccess.Number(r["rotationDegrees"]) * Math.PI / 180;
                if (r["clearOverrides"]?.GetValue<bool>() == true) label.ClearAllTextComponentOverrides();
                if (r["overrides"] is JsonArray overrides)
                    foreach (JsonNode? item in overrides)
                    {
                        ObjectId component = label.GetTextComponentIds().Cast<ObjectId>().Single(i => i.Handle.ToString().Equals(item!["component"]!.ToString(), StringComparison.OrdinalIgnoreCase));
                        label.SetTextComponentOverride(component, item!["text"]!.ToString(), label.GetTextComponentJustificationOverride(component));
                    }
            }
        }
        return new { handle = id.Handle.ToString(), operation = op };
    }
}
