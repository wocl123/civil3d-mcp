using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class ParcelChanges
{
    private static IEnumerable<Site> Sites(Database db, Transaction tr) => CivilDocument.GetCivilDocument(db).GetSiteIds().Cast<ObjectId>().Select(id => (Site)tr.GetObject(id, OpenMode.ForRead));
    private static JsonObject State(Parcel p) => new() { ["handle"] = p.Handle.ToString(), ["name"] = p.Name,
        ["number"] = p.Number, ["address"] = p.Address, ["taxId"] = p.TaxId, ["style"] = p.StyleId.Handle.ToString(),
        ["labelStyle"] = p.AreaSelectionLabelStyleId.Handle.ToString(), ["fingerprint"] = p.ComputeFingerPrint().ToString("X") };
    public static object List(Document doc, JsonObject r)
    {
        using Transaction tr = doc.Database.TransactionManager.StartTransaction();
        int offset = r["offset"]?.GetValue<int>() ?? 0, limit = Math.Clamp(r["limit"]?.GetValue<int>() ?? 20, 1, 50);
        var rows = Sites(doc.Database, tr).SelectMany(s => s.GetParcelIds().Cast<ObjectId>().Select(id => {
            JsonObject row = State((Parcel)tr.GetObject(id, OpenMode.ForRead)); row["site"] = s.Name; row["siteHandle"] = s.Handle.ToString(); return row;
        })).ToArray();
        return new { total = rows.Length, offset, items = rows.Skip(offset).Take(limit).ToArray(), hasMore = offset + limit < rows.Length };
    }
    private static Polyline Source(Database db, Transaction tr, JsonObject r) =>
        CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source")) as Polyline ?? throw new ArgumentException("닫힌 XY 경계 폴리선이 필요합니다.");
    private static void Polygon(Polyline p)
    {
        if (!p.Closed || p.NumberOfVertices is < 3 or > 200 || Math.Abs(p.Elevation) > 1e-8 || !p.Normal.IsEqualTo(Vector3d.ZAxis) || p.Area < 1e-8) throw new ArgumentException("양의 면적을 가진 닫힌 XY(z=0) 폴리선 3~200개 꼭짓점이 필요합니다.");
        int n = p.NumberOfVertices;
        for (int i = 0; i < n; i++)
        {
            if (Math.Abs(p.GetBulgeAt(i)) > 1e-12 || p.GetPoint2dAt(i).GetDistanceTo(p.GetPoint2dAt((i + 1) % n)) < 1e-7) throw new ArgumentException("직선 경계만 지원하며 중복 꼭짓점은 허용하지 않습니다.");
            using var a = new LineSegment2d(p.GetPoint2dAt(i), p.GetPoint2dAt((i + 1) % n));
            Vector2d incoming = p.GetPoint2dAt(i) - p.GetPoint2dAt((i + n - 1) % n);
            Vector2d outgoing = p.GetPoint2dAt((i + 1) % n) - p.GetPoint2dAt(i);
            if (Math.Abs(incoming.X * outgoing.Y - incoming.Y * outgoing.X) < 1e-10 && incoming.DotProduct(outgoing) < 0) throw new ArgumentException("인접 경계가 역방향으로 중첩됩니다.");
            for (int j = i + 1; j < n; j++)
            {
                if (j == i + 1 || (i == 0 && j == n - 1)) continue;
                using var b = new LineSegment2d(p.GetPoint2dAt(j), p.GetPoint2dAt((j + 1) % n));
                if (a.IntersectWith(b) is { Length: > 0 } || a.IsOn(b.StartPoint) || a.IsOn(b.EndPoint) || b.IsOn(a.StartPoint) || b.IsOn(a.EndPoint)) throw new ArgumentException("경계가 교차하거나 중첩됩니다.");
            }
        }
    }
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        if (CivilObjectAccess.Text(r, "operation") == "parcel.create")
        {
            var p = Source(db, tr, r); PrimitiveAccess.Writable(db, tr, p); Polygon(p);
            string site = CivilObjectAccess.Text(r, "siteName"); SymbolUtilityServices.ValidateSymbolName(site, false);
            if (Sites(db, tr).Any(s => s.Name.Equals(site, StringComparison.OrdinalIgnoreCase))) throw new ArgumentException("기존 위상에 영향을 주지 않도록 새 Site 이름을 지정하세요.");
            r["source"] = p.Handle.ToString(); r["sourceState"] = p.GeometricExtents.ToString() + ":" + p.Area.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
            r["verticesState"] = new JsonArray(Enumerable.Range(0, p.NumberOfVertices).Select(i => (JsonNode)new JsonArray(p.GetPoint2dAt(i).X, p.GetPoint2dAt(i).Y)).ToArray());
            details.Add($"원본 경계를 유지하고 새 Site {site}에 실제 Civil 필지 1개를 생성합니다. 분할·면적 자동 최적화는 수행하지 않습니다.");
        }
        else
        {
            var p = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "parcel")) as Parcel ?? throw new ArgumentException("필지 핸들이 필요합니다.");
            CorridorEditing.Guard(db, tr, p); r["sourceState"] = State(p);
            var site = Sites(db, tr).Single(s => s.GetParcelIds().Contains(p.ObjectId));
            CorridorEditing.Guard(db, tr, site); r["siteState"] = site.ComputeFingerPrint().ToString("X");
            if (r["name"] is null && r["address"] is null && r["taxId"] is null) throw new ArgumentException("name/address/taxId 중 수정값을 지정하세요.");
            if (r["name"] is not null) SymbolUtilityServices.ValidateSymbolName(CivilObjectAccess.Text(r, "name"), false);
            if (r["taxId"] is not null) r["taxId"]!.GetValue<int>();
            details.Add("필지 경계와 번호를 유지하고 이름·주소·납세 식별자를 수정합니다.");
        }
        details.AddRange(CivilPlanDetails.Describe(r)); return "Civil 필지 자동 생성·속성 편집";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        if (CivilObjectAccess.Text(r, "operation") == "parcel.create")
        {
            var source = Source(db, tr, r);
            ObjectId id = Site.Create(CivilDocument.GetCivilDocument(db), CivilObjectAccess.Text(r, "siteName"));
            var site = (Site)tr.GetObject(id, OpenMode.ForWrite);
            ParcelComInterop.AddBoundary(db, site, source);
            ObjectId[] parcels = site.GetParcelIds().Cast<ObjectId>().ToArray();
            if (parcels.Length != 1) throw new ArgumentException("경계에서 정확히 하나의 Civil 필지가 생성되지 않았습니다.");
            var p = (Parcel)tr.GetObject(parcels[0], OpenMode.ForWrite);
            CorridorEditing.Guard(db, tr, p);
            return new { handle = p.Handle.ToString(), site = site.Handle.ToString(), parcel = State(p) };
        }
        else
        {
            var p = (Parcel)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "parcel")); p.UpgradeOpen();
            if (r["name"] is not null) p.Name = CivilObjectAccess.Text(r, "name");
            if (r["address"] is not null) p.Address = CivilObjectAccess.Text(r, "address");
            if (r["taxId"] is not null) p.TaxId = r["taxId"]!.GetValue<int>();
            return new { handle = p.Handle.ToString(), parcel = State(p) };
        }
    }
}
