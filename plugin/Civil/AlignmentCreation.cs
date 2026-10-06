using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Autodesk.Civil.Settings;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Node 서비스가 폴리선을 따라 계획한 배치로 선형을 만든다:
/// IP에서 IP까지 고정 직선을 놓고, 반지름이 있는 직선 쌍 사이에 자유 원곡선(또는 완화-원-완화)을 넣는다.
/// 직선은 Civil 3D가 곡선에 맞춰 자른다. 폴리선은 계획할 때 그대로여야 한다.
/// 한 단계라도 실패하면 아무것도 커밋하지 않는다.
/// </summary>
internal static class AlignmentCreation
{
    private const double VertexTolerance = 1e-6;
    private const double ValueTolerance = 0.001;

    public static AlignmentCreateResult Create(Document document, AlignmentCreateRequest request)
    {
        // ── 요청 검사
        AlignmentType type = request.Type switch
        {
            "Centerline" => AlignmentType.Centerline,
            "Utility" => AlignmentType.Utility,
            _ => throw new ArgumentException($"Alignment type {request.Type} is not supported.")
        };
        if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 255)
            throw new ArgumentException("A valid alignment name is required.");
        if (request.Points.Count < 2 || request.Curves.Count != request.Points.Count - 2)
            throw new ArgumentException("The layout needs at least two points and one curve entry per inner point.");

        // ── 같은 이름의 선형이 없고, 폴리선이 계획 때 그대로인지
        Database database = document.Database;
        CivilDocument civil = CivilDocument.GetCivilDocument(database);
        using Transaction transaction = database.TransactionManager.StartTransaction();
        foreach (ObjectId existing in civil.GetAlignmentIds())
            if (transaction.GetObject(existing, OpenMode.ForRead) is Alignment other &&
                string.Equals(other.Name, request.Name, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException($"선형 {request.Name}이(가) 이미 있어 만들지 않았습니다.");
        CheckPolyline(transaction, database, request.Polyline);

        // ── 도면 설정의 선형 스타일·라벨 세트(없으면 첫 번째)
        SettingsAlignment settings = civil.Settings.GetSettings<SettingsAlignment>();
        ObjectId styleId = settings.StyleSettings.AlignmentStyleId.Value;
        if (styleId.IsNull && civil.Styles.AlignmentStyles.Count > 0) styleId = civil.Styles.AlignmentStyles[0];
        ObjectId labelSetId = settings.StyleSettings.AlignmentLabelSetId.Value;
        if (labelSetId.IsNull && civil.Styles.LabelSetStyles.AlignmentLabelSetStyles.Count > 0)
            labelSetId = civil.Styles.LabelSetStyles.AlignmentLabelSetStyles[0];

        // ── 선형 만들기, IP 사이 고정 직선
        ObjectId layerId = Layer(transaction, civil, database);
        ObjectId id = Alignment.Create(civil, request.Name, ObjectId.Null, layerId, styleId, labelSetId, type);
        Alignment alignment = (Alignment)transaction.GetObject(id, OpenMode.ForWrite);
        if (!string.IsNullOrWhiteSpace(request.Description)) alignment.Description = request.Description;
        List<int> lines = new();
        for (int index = 0; index < request.Points.Count - 1; index++)
            lines.Add(alignment.Entities.AddFixedLine(Point(request.Points[index]), Point(request.Points[index + 1])).EntityId);

        // ── 곡선: 완화곡선 길이가 있으면 SCS(클로소이드), 없으면 원곡선. 반지름이 계획과 다르면 실패.
        List<CreatedCurve> curves = new();
        for (int index = 0; index < request.Curves.Count; index++)
        {
            PlannedCurve planned = request.Curves[index];
            if (planned.Radius is not double radius || radius <= 0) continue;
            double actual = planned.SpiralLength is double spiral && spiral > 0
                ? alignment.Entities.AddFreeSCS(lines[index], lines[index + 1], spiral, spiral, SpiralParamType.Length,
                    radius, false, Autodesk.Civil.SpiralType.Clothoid).Arc.Radius
                : alignment.Entities.AddFreeCurve(lines[index], lines[index + 1], radius, CurveParamType.Radius,
                    false, CurveType.Compound).Radius;
            if (Math.Abs(actual - radius) > ValueTolerance)
                throw new InvalidOperationException($"IP{index + 1} 곡선을 R {radius}로 넣지 못했습니다(Civil 3D 결과 {Math.Round(actual, 3)}).");
            curves.Add(new CreatedCurve(index + 1, Math.Round(actual, 4), planned.SpiralLength));
        }

        // ── 설계속도(중심선 선형만)
        if (type == AlignmentType.Centerline && request.DesignSpeed is double speed)
        {
            if (alignment.DesignSpeeds.Count > 0) alignment.DesignSpeeds[0].Value = speed;
            else alignment.DesignSpeeds.Add(alignment.StartingStation, speed);
        }

        AlignmentCreateResult result = new(alignment.Name, alignment.Handle.ToString(), type.ToString(),
            Math.Round(alignment.Length, 3), curves, string.Empty);
        transaction.Commit();
        return result with { Revision = DrawingRevisions.Of(database) };
    }

    // 폴리선의 꼭짓점(좌표·볼록도)이 계획할 때와 그대로인지.
    private static void CheckPolyline(Transaction transaction, Database database, PlannedPolyline planned)
    {
        if (!long.TryParse(planned.Handle, System.Globalization.NumberStyles.HexNumber, null, out long value) ||
            !database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased ||
            transaction.GetObject(id, OpenMode.ForRead) is not Polyline polyline)
            throw new ArgumentException($"폴리라인 {planned.Handle}을(를) 찾지 못했습니다.");
        bool same = polyline.NumberOfVertices == planned.Vertices.Count && Enumerable.Range(0, planned.Vertices.Count).All(index =>
        {
            Point2d point = polyline.GetPoint2dAt(index);
            PlannedVertex vertex = planned.Vertices[index];
            return Math.Abs(point.X - vertex.X) < VertexTolerance && Math.Abs(point.Y - vertex.Y) < VertexTolerance &&
                Math.Abs(polyline.GetBulgeAt(index) - vertex.Bulge) < VertexTolerance;
        });
        if (!same) throw new InvalidOperationException($"폴리라인 {planned.Handle}이(가) 계획 뒤에 바뀌어 만들지 않았습니다. 다시 계획하세요.");
    }

    // 도면 설정(Object Layers)의 선형 레이어. 없으면 현재 레이어.
    private static ObjectId Layer(Transaction transaction, CivilDocument civil, Database database)
    {
        string name = civil.Settings.DrawingSettings.ObjectLayerSettings.GetObjectLayerSetting(SettingsObjectLayerType.Alignment).LayerName;
        LayerTable layers = (LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForRead);
        return !string.IsNullOrEmpty(name) && layers.Has(name) ? layers[name] : database.Clayer;
    }

    private static Point3d Point(PlannedPoint point) => new(point.X, point.Y, 0);
}
