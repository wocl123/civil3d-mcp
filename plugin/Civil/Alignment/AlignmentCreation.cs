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
        AlignmentType type = ParseType(request.Type);

        if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 255)
        {
            throw new ArgumentException("A valid alignment name is required.");
        }

        bool hasCurvePerInnerPoint = request.Curves.Count == request.Points.Count - 2;
        if (request.Points.Count < 2 || !hasCurvePerInnerPoint)
        {
            throw new ArgumentException("The layout needs at least two points and one curve entry per inner point.");
        }

        // ── 같은 이름의 선형이 없고, 폴리선이 계획 때 그대로인지
        Database database = document.Database;
        CivilDocument civil = CivilDocument.GetCivilDocument(database);
        using Transaction transaction = database.TransactionManager.StartTransaction();

        EnsureNameIsFree(transaction, civil, request.Name);
        CheckPolyline(transaction, database, request.Polyline);

        // ── 선형 만들기, IP 사이 고정 직선
        ObjectId layerId = Layer(transaction, civil, database);
        ObjectId styleId = DefaultStyle(civil);
        ObjectId labelSetId = DefaultLabelSet(civil);

        ObjectId id = Alignment.Create(civil, request.Name, ObjectId.Null, layerId, styleId, labelSetId, type);
        Alignment alignment = (Alignment)transaction.GetObject(id, OpenMode.ForWrite);

        if (!string.IsNullOrWhiteSpace(request.Description))
        {
            alignment.Description = request.Description;
        }

        List<int> lines = AddFixedLines(alignment, request.Points);

        // ── 곡선
        List<CreatedCurve> curves = new();
        for (int index = 0; index < request.Curves.Count; index++)
        {
            CreatedCurve? curve = AddCurve(alignment, lines, index, request.Curves[index]);
            if (curve is not null)
            {
                curves.Add(curve);
            }
        }

        // ── 설계속도(중심선 선형만)
        if (type == AlignmentType.Centerline && request.DesignSpeed is double speed)
        {
            SetDesignSpeed(alignment, speed);
        }

        AlignmentCreateResult result = new(
            alignment.Name, alignment.Handle.ToString(), type.ToString(),
            Math.Round(alignment.Length, 3), curves, string.Empty);

        transaction.Commit();
        return result with { Revision = DrawingRevisions.Of(database) };
    }

    private static AlignmentType ParseType(string type) => type switch
    {
        "Centerline" => AlignmentType.Centerline,
        "Utility" => AlignmentType.Utility,
        _ => throw new ArgumentException($"Alignment type {type} is not supported.")
    };

    private static void EnsureNameIsFree(Transaction transaction, CivilDocument civil, string name)
    {
        foreach (ObjectId existingId in civil.GetAlignmentIds())
        {
            if (transaction.GetObject(existingId, OpenMode.ForRead) is not Alignment existing)
            {
                continue;
            }

            if (string.Equals(existing.Name, name, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException($"선형 {name}이(가) 이미 있어 만들지 않았습니다.");
            }
        }
    }

    // 도면 설정의 선형 스타일. 설정이 비어 있으면 첫 번째 스타일.
    private static ObjectId DefaultStyle(CivilDocument civil)
    {
        SettingsAlignment settings = civil.Settings.GetSettings<SettingsAlignment>();
        ObjectId styleId = settings.StyleSettings.AlignmentStyleId.Value;

        if (styleId.IsNull && civil.Styles.AlignmentStyles.Count > 0)
        {
            styleId = civil.Styles.AlignmentStyles[0];
        }

        return styleId;
    }

    // 도면 설정의 선형 라벨 세트. 설정이 비어 있으면 첫 번째 라벨 세트.
    private static ObjectId DefaultLabelSet(CivilDocument civil)
    {
        SettingsAlignment settings = civil.Settings.GetSettings<SettingsAlignment>();
        ObjectId labelSetId = settings.StyleSettings.AlignmentLabelSetId.Value;
        var labelSets = civil.Styles.LabelSetStyles.AlignmentLabelSetStyles;

        if (labelSetId.IsNull && labelSets.Count > 0)
        {
            labelSetId = labelSets[0];
        }

        return labelSetId;
    }

    // IP와 다음 IP를 잇는 고정 직선들. 돌려주는 값은 각 직선의 EntityId.
    private static List<int> AddFixedLines(Alignment alignment, IReadOnlyList<PlannedPoint> points)
    {
        List<int> lines = new();

        for (int index = 0; index < points.Count - 1; index++)
        {
            Point3d start = Point(points[index]);
            Point3d end = Point(points[index + 1]);
            lines.Add(alignment.Entities.AddFixedLine(start, end).EntityId);
        }

        return lines;
    }

    // index번째 IP의 곡선을 앞뒤 직선 사이에 넣는다.
    // 완화곡선 길이가 있으면 SCS(클로소이드), 없으면 원곡선. 반지름이 없으면 곡선 없이 넘어간다(null).
    // Civil 3D가 만든 반지름이 계획과 다르면 실패.
    private static CreatedCurve? AddCurve(Alignment alignment, List<int> lines, int index, PlannedCurve planned)
    {
        double radius = planned.Radius ?? 0;
        if (radius <= 0)
        {
            return null;
        }

        int lineBefore = lines[index];
        int lineAfter = lines[index + 1];
        double actualRadius;

        if (planned.SpiralLength is double spiral && spiral > 0)
        {
            AlignmentSCS scs = alignment.Entities.AddFreeSCS(
                lineBefore, lineAfter, spiral, spiral, SpiralParamType.Length,
                radius, false, Autodesk.Civil.SpiralType.Clothoid);
            actualRadius = scs.Arc.Radius;
        }
        else
        {
            AlignmentArc arc = alignment.Entities.AddFreeCurve(
                lineBefore, lineAfter, radius, CurveParamType.Radius, false, CurveType.Compound);
            actualRadius = arc.Radius;
        }

        if (Math.Abs(actualRadius - radius) > ValueTolerance)
        {
            throw new InvalidOperationException(
                $"IP{index + 1} 곡선을 R {radius}로 넣지 못했습니다(Civil 3D 결과 {Math.Round(actualRadius, 3)}).");
        }

        return new CreatedCurve(index + 1, Math.Round(actualRadius, 4), planned.SpiralLength);
    }

    private static void SetDesignSpeed(Alignment alignment, double speed)
    {
        if (alignment.DesignSpeeds.Count > 0)
        {
            alignment.DesignSpeeds[0].Value = speed;
        }
        else
        {
            alignment.DesignSpeeds.Add(alignment.StartingStation, speed);
        }
    }

    // 폴리선의 꼭짓점(좌표·볼록도)이 계획할 때와 그대로인지.
    private static void CheckPolyline(Transaction transaction, Database database, PlannedPolyline planned)
    {
        Polyline? polyline = FindPolyline(transaction, database, planned.Handle);
        if (polyline is null)
        {
            throw new ArgumentException($"폴리라인 {planned.Handle}을(를) 찾지 못했습니다.");
        }

        bool sameCount = polyline.NumberOfVertices == planned.Vertices.Count;
        bool sameVertices = sameCount
            && Enumerable.Range(0, planned.Vertices.Count)
                .All(index => SameVertex(polyline, index, planned.Vertices[index]));

        if (!sameVertices)
        {
            throw new InvalidOperationException(
                $"폴리라인 {planned.Handle}이(가) 계획 뒤에 바뀌어 만들지 않았습니다. 다시 계획하세요.");
        }
    }

    // 핸들(16진수 문자열)로 지워지지 않은 폴리선을 찾는다. 없으면 null.
    private static Polyline? FindPolyline(Transaction transaction, Database database, string handle)
    {
        if (!long.TryParse(handle, System.Globalization.NumberStyles.HexNumber, null, out long value))
        {
            return null;
        }

        if (!database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased)
        {
            return null;
        }

        return transaction.GetObject(id, OpenMode.ForRead) as Polyline;
    }

    private static bool SameVertex(Polyline polyline, int index, PlannedVertex vertex)
    {
        Point2d point = polyline.GetPoint2dAt(index);
        double bulge = polyline.GetBulgeAt(index);

        return Math.Abs(point.X - vertex.X) < VertexTolerance
            && Math.Abs(point.Y - vertex.Y) < VertexTolerance
            && Math.Abs(bulge - vertex.Bulge) < VertexTolerance;
    }

    // 도면 설정(Object Layers)의 선형 레이어. 없으면 현재 레이어.
    private static ObjectId Layer(Transaction transaction, CivilDocument civil, Database database)
    {
        string name = civil.Settings.DrawingSettings.ObjectLayerSettings
            .GetObjectLayerSetting(SettingsObjectLayerType.Alignment)
            .LayerName;
        LayerTable layers = (LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForRead);

        bool layerExists = !string.IsNullOrEmpty(name) && layers.Has(name);
        return layerExists ? layers[name] : database.Clayer;
    }

    private static Point3d Point(PlannedPoint point) => new(point.X, point.Y, 0);
}
