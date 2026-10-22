using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class AlignmentFromPolyline
{
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        string name = CivilObjectAccess.Text(r, "name"); CivilObjectAccess.FreeName<Alignment>(tr, db, name);
        var poly = CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source")) as Polyline ?? throw new ArgumentException("열린 XY 경량 폴리선을 지정하세요.");
        PrimitiveAccess.Writable(db, tr, poly);
        if (poly.Closed || poly.NumberOfVertices < 2 || poly.NumberOfVertices > 1000 || poly.Length <= 1e-9
            || !poly.Normal.IsEqualTo(Vector3d.ZAxis) || Math.Abs(poly.Elevation) > 1e-9) throw new ArgumentException("XY(z=0)의 열린 경량 폴리선이 필요합니다.");
        r["source"] = poly.Handle.ToString(); r["sourceState"] = GeometryEditing.Snapshot(poly);
        CivilObjectAccess.Style(tr, db, "alignment", r["style"]?.ToString()); CivilObjectAccess.Style(tr, db, "alignmentLabels", r["labelSet"]?.ToString());
        PrimitiveAccess.Layer(db, tr, r);
        details.Add("기존 선·원곡선 세그먼트를 따라 선형 생성. 원본 폴리선 보존, 임의 곡선·완화곡선은 추가하지 않습니다.");
        details.AddRange(CivilPlanDetails.Describe(r)); return "폴리선에서 선형 생성";
    }
    public static object Apply(Database db, Transaction tr, JsonObject r)
    {
        var source = (Polyline)CivilObjectAccess.ByHandle(tr, db, CivilObjectAccess.Text(r, "source"));
        var options = new PolylineOptions { PlineId = source.ObjectId, AddCurvesBetweenTangents = false, EraseExistingEntities = false };
        ObjectId id = Alignment.Create(CivilDocument.GetCivilDocument(db), options, CivilObjectAccess.Text(r, "name"), ObjectId.Null,
            PrimitiveAccess.Layer(db, tr, r), CivilObjectAccess.Style(tr, db, "alignment", r["style"]?.ToString()), CivilObjectAccess.Style(tr, db, "alignmentLabels", r["labelSet"]?.ToString()));
        return new { handle = id.Handle.ToString(), name = CivilObjectAccess.Text(r, "name") };
    }
}
