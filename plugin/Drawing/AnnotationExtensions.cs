using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

internal static class AnnotationExtensions
{
    private static BlockTableRecord Block(Database db, Transaction tr, string name)
    {
        BlockTable table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
        if (!table.Has(name)) throw new ArgumentException("블록 정의가 없습니다.");
        BlockTableRecord b = (BlockTableRecord)tr.GetObject(table[name], OpenMode.ForRead);
        if (b.IsLayout || b.IsAnonymous || b.IsFromExternalReference || b.IsFromOverlayReference)
            throw new ArgumentException("일반 로컬 이름 블록만 지원합니다.");
        return b;
    }
    public static object ListBlocks(Document doc, int offset, int limit)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        var all = ((BlockTable)tr.GetObject(doc.Database.BlockTableId, OpenMode.ForRead)).Cast<ObjectId>()
            .Select(i => (BlockTableRecord)tr.GetObject(i, OpenMode.ForRead)).Where(b => !b.IsLayout && !b.IsAnonymous)
            .Select(b => new { name = b.Name, handle = b.Handle.ToString(), external = b.IsFromExternalReference,
                origin = PrimitiveAccess.JsonPoint(b.Origin), attributes = b.Cast<ObjectId>().Select(i => tr.GetObject(i, OpenMode.ForRead))
                    .OfType<AttributeDefinition>().Select(a => new { tag = a.Tag, value = a.TextString, constant = a.Constant }).ToArray() }).ToArray();
        return new { total = all.Length, offset, items = all.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < all.Length };
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "block.create")
        {
            string name = CivilObjectAccess.Text(r, "name"); SymbolUtilityServices.ValidateSymbolName(name, false);
            if (((BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead)).Has(name)) throw new ArgumentException("블록 이름이 이미 있습니다.");
            var entities = PrimitiveAccess.Targets<Autodesk.AutoCAD.DatabaseServices.Entity>(db, tr, r);
            if (entities.Any(e => e is not (Line or Polyline or Arc or Circle or DBText or MText or DBPoint)))
                throw new ArgumentException("블록 정의에는 일반 선·폴리선·원·호·문자·점만 넣습니다.");
            PrimitiveAccess.Point(r["basePoint"]);
            r["sourceState"] = new JsonArray(entities.Select(Snapshot).ToArray());
            details.Add("원본을 유지하고 일반 객체를 복제한 블록 정의를 만듭니다. 삽입은 별도 작업입니다.");
        }
        else if (op == "block.insert")
        {
            BlockTableRecord b = Block(db, tr, CivilObjectAccess.Text(r, "name"));
            PrimitiveAccess.Point(r["position"]); PrimitiveAccess.Layer(db, tr, r);
            if (r["scale"] is not null && CivilObjectAccess.Number(r["scale"]) <= 0) throw new ArgumentException("블록 축척은 양수입니다.");
            if (r["rotationDegrees"] is not null) CivilObjectAccess.Number(r["rotationDegrees"]);
            var definitions = b.Cast<ObjectId>().Select(i => tr.GetObject(i, OpenMode.ForRead)).OfType<AttributeDefinition>().ToArray();
            if (r["attributes"] is JsonObject attrs)
                foreach (var entry in attrs)
                    if (!definitions.Any(a => !a.Constant && a.Tag.Equals(entry.Key, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException($"쓰기 가능한 속성 태그 {entry.Key}가 없습니다.");
            r["sourceState"] = new JsonObject { ["handle"] = b.Handle.ToString(),
                ["objects"] = new JsonArray(b.Cast<ObjectId>().Select(i => JsonValue.Create(i.Handle.ToString())).ToArray()) };
        }
        else if (op == "block.attributes")
        {
            BlockReference b = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")) as BlockReference ?? throw new ArgumentException("블록 참조를 지정하세요.");
            PrimitiveAccess.Writable(db, tr, b);
            var attrs = b.AttributeCollection.Cast<ObjectId>().Select(i => (AttributeReference)tr.GetObject(i, OpenMode.ForRead)).ToArray();
            if (r["attributes"] is not JsonObject changes || changes.Count == 0) throw new ArgumentException("속성 태그와 새 값을 지정하세요.");
            foreach (var entry in changes)
                if (attrs.Count(a => a.Tag.Equals(entry.Key, StringComparison.OrdinalIgnoreCase)) != 1) throw new ArgumentException("속성 태그가 없거나 중복됩니다.");
            r["sourceState"] = new JsonArray(attrs.Select(a => (JsonNode)new JsonObject { ["tag"] = a.Tag, ["text"] = a.TextString }).ToArray());
        }
        else if (op == "hatch.create")
        {
            var targets = PrimitiveAccess.Targets<Polyline>(db, tr, r).Cast<Polyline>().ToArray();
            if (targets.Any(p => !p.Closed || p.NumberOfVertices < 3 || (p.Normal - Vector3d.ZAxis).Length > 1e-9 || Math.Abs(p.Elevation - targets[0].Elevation) > 1e-9))
                throw new ArgumentException("같은 WCS XY 평면의 닫힌 폴리선만 해치 경계로 사용합니다. 첫 경계는 외곽, 나머지는 구멍입니다.");
            r["sourceState"] = new JsonArray(targets.Select(GeometryEditing.Snapshot).ToArray());
            PrimitiveAccess.Layer(db, tr, r);
            CivilObjectAccess.Text(r, "pattern");
            if (r["patternScale"] is not null && CivilObjectAccess.Number(r["patternScale"]) <= 0) throw new ArgumentException("해치 축척은 양수입니다.");
        }
        else if (op == "leader.create")
        {
            PrimitiveAccess.Point(r["arrowPoint"]); PrimitiveAccess.Point(r["textPosition"]);
            if (string.IsNullOrWhiteSpace(CivilObjectAccess.Text(r, "text"))) throw new ArgumentException("지시선 문자가 필요합니다.");
            if (CivilObjectAccess.Number(r["height"]) <= 0) throw new ArgumentException("문자 높이는 양수입니다.");
            PrimitiveAccess.Layer(db, tr, r);
        }
        else if (op == "table.create")
        {
            PrimitiveAccess.Point(r["position"]); PrimitiveAccess.Layer(db, tr, r);
            if (r["rows"] is not JsonArray rows || rows.Count is < 1 or > 100 || rows[0] is not JsonArray first || first.Count is < 1 or > 20
                || rows.Any(row => row is not JsonArray cols || cols.Count != first.Count)) throw new ArgumentException("표는 같은 열 수의 1~100행, 1~20열로 지정하세요.");
            foreach (string key in new[] { "rowHeight", "columnWidth", "height" }) if (CivilObjectAccess.Number(r[key]) <= 0) throw new ArgumentException("표 치수는 양수입니다.");
        }
        else throw new ArgumentException("알 수 없는 주석 작업입니다.");
        details.AddRange(CivilPlanDetails.Describe(r));
        return CivilPlanDetails.Title(op);
    }
    private static JsonNode Snapshot(Autodesk.AutoCAD.DatabaseServices.Entity e) => e is Curve ? GeometryEditing.Snapshot(e)
        : new JsonObject { ["handle"] = e.Handle.ToString(), ["layer"] = e.Layer,
            ["text"] = e is DBText t ? t.TextString : e is MText m ? m.Contents : null,
            ["position"] = e is DBText tt ? PrimitiveAccess.JsonPoint(tt.Position) : e is MText mm ? PrimitiveAccess.JsonPoint(mm.Location) : e is DBPoint p ? PrimitiveAccess.JsonPoint(p.Position) : null };

    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        string op = CivilObjectAccess.Text(r, "operation");
        if (op == "block.create")
        {
            BlockTable table = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
            var b = new BlockTableRecord { Name = CivilObjectAccess.Text(r, "name"), Origin = PrimitiveAccess.Point(r["basePoint"]) };
            table.Add(b); tr.AddNewlyCreatedDBObject(b, true);
            var ids = new ObjectIdCollection(((JsonArray)r["handles"]!).Select(h => CivilObjectAccess.ByHandle(tr, db, h!.ToString()).ObjectId).ToArray());
            db.DeepCloneObjects(ids, b.ObjectId, new IdMapping(), false);
            return new { name = b.Name, handle = b.Handle.ToString() };
        }
        if (op == "block.attributes")
        {
            var b = (BlockReference)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "handle")); b.UpgradeOpen();
            foreach (var entry in (JsonObject)r["attributes"]!)
            {
                var a = b.AttributeCollection.Cast<ObjectId>().Select(i => (AttributeReference)tr.GetObject(i, OpenMode.ForRead)).Single(a => a.Tag.Equals(entry.Key, StringComparison.OrdinalIgnoreCase));
                a.UpgradeOpen(); a.TextString = entry.Value!.ToString();
            }
            return new { handle = b.Handle.ToString() };
        }
        Autodesk.AutoCAD.DatabaseServices.Entity created;
        if (op == "block.insert")
        {
            var definition = Block(db, tr, CivilObjectAccess.Text(r, "name"));
            var b = new BlockReference(PrimitiveAccess.Point(r["position"]), definition.ObjectId) {
                ScaleFactors = new Scale3d(r["scale"] is null ? 1 : CivilObjectAccess.Number(r["scale"])),
                Rotation = (r["rotationDegrees"] is null ? 0 : CivilObjectAccess.Number(r["rotationDegrees"])) * Math.PI / 180 };
            b.LayerId = PrimitiveAccess.Layer(db, tr, r); PrimitiveAccess.Append(db, tr, b);
            foreach (var a in definition.Cast<ObjectId>().Select(i => tr.GetObject(i, OpenMode.ForRead)).OfType<AttributeDefinition>().Where(a => !a.Constant))
            {
                var value = new AttributeReference(); value.SetAttributeFromBlock(a, b.BlockTransform);
                var entry = (r["attributes"] as JsonObject)?.FirstOrDefault(k => k.Key.Equals(a.Tag, StringComparison.OrdinalIgnoreCase));
                value.TextString = entry?.Value?.ToString() ?? a.TextString;
                b.AttributeCollection.AppendAttribute(value); tr.AddNewlyCreatedDBObject(value, true);
            }
            return new { handle = b.Handle.ToString(), name = definition.Name };
        }
        if (op == "hatch.create")
        {
            Polyline[] bounds = ((JsonArray)r["handles"]!).Select(h => (Polyline)CivilObjectAccess.ByHandle(tr, db, h!.ToString())).ToArray();
            var h = new Hatch { Elevation = bounds[0].Elevation, Normal = Vector3d.ZAxis };
            h.SetDatabaseDefaults(db); h.LayerId = PrimitiveAccess.Layer(db, tr, r); PrimitiveAccess.Append(db, tr, h);
            h.SetHatchPattern(HatchPatternType.PreDefined, CivilObjectAccess.Text(r, "pattern"));
            h.PatternScale = r["patternScale"] is null ? 1 : CivilObjectAccess.Number(r["patternScale"]);
            h.PatternAngle = (r["rotationDegrees"] is null ? 0 : CivilObjectAccess.Number(r["rotationDegrees"])) * Math.PI / 180;
            h.Associative = true;
            for (int i = 0; i < bounds.Length; i++) h.AppendLoop(i == 0 ? HatchLoopTypes.Outermost : HatchLoopTypes.Default, new ObjectIdCollection(new[] { bounds[i].ObjectId }));
            h.EvaluateHatch(true);
            return new { handle = h.Handle.ToString() };
        }
        if (op == "leader.create")
        {
            var m = new MLeader(); m.SetDatabaseDefaults(db); m.ContentType = ContentType.MTextContent;
            using var text = new MText { Contents = CivilObjectAccess.Text(r, "text"), TextHeight = CivilObjectAccess.Number(r["height"]), Location = PrimitiveAccess.Point(r["textPosition"]) };
            m.MText = text;
            int leader = m.AddLeader(); int line = m.AddLeaderLine(leader);
            m.AddFirstVertex(line, PrimitiveAccess.Point(r["arrowPoint"])); m.AddLastVertex(line, PrimitiveAccess.Point(r["textPosition"]));
            created = m;
        }
        else if (op == "table.create")
        {
            var rows = (JsonArray)r["rows"]!;
            var table = new Table { TableStyle = db.Tablestyle, Position = PrimitiveAccess.Point(r["position"]) };
            table.SetSize(rows.Count, rows[0]!.AsArray().Count);
            table.SetRowHeight(CivilObjectAccess.Number(r["rowHeight"])); table.SetColumnWidth(CivilObjectAccess.Number(r["columnWidth"]));
            for (int i = 0; i < rows.Count; i++) for (int j = 0; j < rows[i]!.AsArray().Count; j++)
            { table.Cells[i, j].TextString = rows[i]![j]!.ToString(); table.Cells[i, j].TextHeight = CivilObjectAccess.Number(r["height"]); }
            table.GenerateLayout(); created = table;
        }
        else throw new ArgumentException("알 수 없는 주석 작업입니다.");
        created.LayerId = PrimitiveAccess.Layer(db, tr, r); PrimitiveAccess.Append(db, tr, created);
        return new { handle = created.Handle.ToString() };
    }
}
