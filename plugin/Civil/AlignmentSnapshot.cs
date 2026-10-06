using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 선형 하나에서 읽는 모든 것을 구간(section)별로 묶은 것. 도면 리비전마다 한 번 만들고
/// 구간별로 나눠 준다. 교각, 주요 측점처럼 Civil 3D가 계산한 값은 다시 계산하지 않고 읽는다.
/// 읽지 못한 부분은 Unavailable에 적는다.
/// </summary>
internal sealed class AlignmentSnapshot
{
    public required AlignmentOverview Overview { get; init; }
    public required IReadOnlyList<AlignmentElement> Elements { get; init; }
    public required IReadOnlyList<AlignmentCurve> Curves { get; init; }
    public required IReadOnlyList<AlignmentKeyPoint> KeyPoints { get; init; }
    public required IReadOnlyList<AlignmentStationEquation> StationEquations { get; init; }
    public required IReadOnlyList<AlignmentDesignSpeed> DesignSpeeds { get; init; }
    public required IReadOnlyList<AlignmentSuperelevationStation> Superelevation { get; init; }
    public required IReadOnlyList<AlignmentOffsetInfo> Offset { get; init; }
    public required IReadOnlyList<AlignmentRelated> Related { get; init; }

    public static readonly string[] SectionNames =
        ["curves", "elements", "key_points", "station_equations", "design_speeds", "superelevation", "offset", "related", "design_checks"];

    public static AlignmentSnapshot Read(Transaction transaction, Alignment alignment)
    {
        // 한 부분이 실패하면 그 이유만 적고 계속한다.
        List<string> unavailable = new();
        T? Try<T>(string part, Func<T> read)
        {
            try { return read(); }
            catch (System.Exception ex)
            {
                unavailable.Add($"{part}: {ex.Message}");
                return default;
            }
        }

        // ── 구간별로 읽기
        bool checks = alignment.UseDesignCheckSet;
        (List<AlignmentElement> elements, List<AlignmentCurve> curves) =
            Try<(List<AlignmentElement>, List<AlignmentCurve>)?>("elements", () => ReadElements(alignment, checks)) ?? (new(), new());
        List<AlignmentKeyPoint> keyPoints = Try("key_points", () => ReadKeyPoints(alignment)) ?? new();
        List<AlignmentStationEquation> equations = Try("station_equations", () => alignment.StationEquations
            .Select(item => new AlignmentStationEquation(Round(item.RawStationBack), Round(item.StationBack),
                Round(item.StationAhead), item.EquationType.ToString())).ToList()) ?? new();
        List<AlignmentDesignSpeed> speeds = Try("design_speeds", () => alignment.DesignSpeeds
            .Select(item => new AlignmentDesignSpeed(Round(item.Station), StationText(alignment, item.Station), Round(item.Value))
            { Comment = string.IsNullOrWhiteSpace(item.Comment) ? null : item.Comment }).ToList()) ?? new();
        List<AlignmentSuperelevationStation> superelevation =
            Try("superelevation", () => ReadSuperelevation(alignment)) ?? new();
        List<AlignmentOffsetInfo> offset = alignment.IsOffsetAlignment
            ? Try("offset", () => ReadOffset(transaction, alignment)) is { } info ? [info] : []
            : [];
        List<AlignmentRelated> related = Try("related", () => ReadRelated(transaction, alignment)) is { } links ? [links] : [];

        // ── 개요: 요약, 설정, 구간별 개수
        AlignmentSummary summary = AlignmentQueries.Summarize(transaction, alignment);
        AlignmentSettings settings = new(
            Round(alignment.ReferencePointStation), Point(alignment.ReferencePoint), Round(alignment.StationIndexIncrement),
            alignment.SuperelevationType.ToString(), alignment.UseDesignSpeed,
            alignment.UseDesignCriteriaFile, Blank(alignment.CriteriaFileName),
            checks, Blank(alignment.DesignCheckSetName), alignment.IsConnectedAlignment);
        int violations = elements.Sum(item => item.DesignViolations?.Count ?? 0);
        Dictionary<string, int> sections = new()
        {
            ["curves"] = curves.Count,
            ["elements"] = elements.Count,
            ["key_points"] = keyPoints.Count,
            ["station_equations"] = equations.Count,
            ["design_speeds"] = speeds.Count,
            ["superelevation"] = superelevation.Count,
            ["offset"] = offset.Count,
            ["related"] = related.Count,
            ["design_checks"] = violations
        };
        if (!checks) unavailable.Add("design_checks: the alignment does not use a design check set.");

        return new AlignmentSnapshot
        {
            Overview = new AlignmentOverview(summary, settings, sections, unavailable),
            Elements = elements, Curves = curves, KeyPoints = keyPoints, StationEquations = equations,
            DesignSpeeds = speeds, Superelevation = superelevation, Offset = offset, Related = related
        };
    }

    /// <summary>구간 하나의 항목. 측점 범위를 주면 그 범위와 겹치는 것만.</summary>
    public IEnumerable<object> Section(string name, double? from, double? to)
    {
        bool Overlaps(double start, double end) => (from is null || end >= from) && (to is null || start <= to);
        bool Within(double station) => (from is null || station >= from) && (to is null || station <= to);
        return name switch
        {
            "curves" => Curves.Where(item => Overlaps(item.StartStation, item.EndStation)),
            "elements" => Elements.Where(item => Overlaps(item.StartStation, item.EndStation)),
            "key_points" => KeyPoints.Where(item => Within(item.Station)),
            "station_equations" => StationEquations.Where(item => Within(item.RawStationBack)),
            "design_speeds" => DesignSpeeds,
            "superelevation" => Superelevation.Where(item => Within(item.Station)),
            "offset" => Offset,
            "related" => Related,
            "design_checks" => Elements.Where(item => item.DesignViolations is { Count: > 0 } && Overlaps(item.StartStation, item.EndStation)),
            _ => throw new ArgumentException($"Unknown section '{name}'. Use one of: {string.Join(", ", SectionNames)}.")
        };
    }

    // 요소(직선·원곡선·완화곡선 하나하나)와 곡선(요소를 Civil 3D 엔티티 단위로 묶은 것: 예 SCS 하나).
    // 곡선에는 최소 반지름, 교각 합, 완화곡선 A(앞·뒤)를 모아 둔다.
    private static (List<AlignmentElement>, List<AlignmentCurve>) ReadElements(Alignment alignment, bool checks)
    {
        List<AlignmentElement> elements = new();
        List<AlignmentCurve> curves = new();
        for (int index = 0; index < alignment.Entities.Count; index++)
        {
            AlignmentEntity entity = alignment.Entities.GetEntityByOrder(index);
            string group = entity.EntityType.ToString();
            List<AlignmentElement> parts = new();
            for (int part = 0; part < entity.SubEntityCount; part++)
            {
                AlignmentSubEntity sub = entity[part];
                parts.Add(Describe(alignment, sub, elements.Count + parts.Count + 1,
                    entity.EntityType == AlignmentEntityType.Line ? 0 : curves.Count + 1, group, checks));
            }
            elements.AddRange(parts);
            if (entity.EntityType == AlignmentEntityType.Line || parts.Count == 0) continue;

            double[] radii = parts.Where(item => item.Radius is not null).Select(item => item.Radius!.Value).ToArray();
            double[] deltas = parts.Where(item => item.DeltaDeg is not null).Select(item => item.DeltaDeg!.Value).ToArray();
            AlignmentElement[] spirals = parts.Where(item => item.Kind == "Spiral").ToArray();
            string[] turns = parts.Select(item => item.Turn).OfType<string>().Distinct().ToArray();
            AlignmentElement first = parts[0], last = parts[^1];
            curves.Add(new AlignmentCurve(curves.Count + 1, group, first.StartStation, last.EndStation,
                first.StartStationText, last.EndStationText, Round(parts.Sum(item => item.Length)),
                turns.Length == 1 ? turns[0] : turns.Length > 1 ? "mixed" : null,
                radii.Length > 0 ? radii.Min() : null, deltas.Length > 0 ? Round(deltas.Sum()) : null,
                spirals.FirstOrDefault()?.SpiralA, spirals.Length > 1 ? spirals[^1].SpiralA : null, parts.Count));
        }
        return (elements, curves);
    }

    // 요소 하나: 공통 값 + 종류별 값(직선 방위각, 원곡선 R·교각·접선장 등, 완화곡선 A·K·P 등).
    private static AlignmentElement Describe(Alignment alignment, AlignmentSubEntity sub, int order, int curveGroup,
        string group, bool checks)
    {
        AlignmentElement element = new(order, curveGroup, sub.SubEntityType.ToString(), group,
            Round(sub.StartStation), Round(sub.EndStation), StationText(alignment, sub.StartStation),
            StationText(alignment, sub.EndStation), Round(sub.Length), Point(sub.StartPoint), Point(sub.EndPoint))
        {
            DesignViolations = checks ? Violations(sub) : null
        };
        return sub switch
        {
            // 방위각은 양 끝점으로 계산한다: 도북에서 시계 방향 각도(도).
            AlignmentSubEntityLine line => element with { AzimuthDeg = Azimuth(line.StartPoint, line.EndPoint) },
            AlignmentSubEntityArc arc => element with
            {
                Radius = Round(arc.Radius), Turn = arc.Clockwise ? "right" : "left", DeltaDeg = Degrees(arc.Delta),
                Tangent = Finite(arc.ExternalTangent), External = Finite(arc.ExternalSecant),
                MidOrdinate = Finite(arc.MidOrdinate), Chord = Finite(arc.ChordLength), Center = Point(arc.CenterPoint),
                PiPoint = Point(arc.PIPoint), PiStationText = StationText(alignment, arc.PIStation), Reverse = arc.ReverseCurve
            },
            AlignmentSubEntitySpiral spiral => element with
            {
                SpiralA = Finite(spiral.A), RadiusIn = Finite(spiral.RadiusIn), RadiusOut = Finite(spiral.RadiusOut),
                Turn = spiral.Direction == SpiralDirectionType.DirectionRight ? "right" : "left",
                DeltaDeg = Degrees(spiral.Delta), SpiralDefinition = spiral.SpiralDefinition.ToString(),
                SpiralInOut = spiral.CurveType == SpiralCurveType.InCurve ? "in" : "out",
                SpiralK = Finite(spiral.K), SpiralP = Finite(spiral.P),
                LongTangent = Finite(spiral.LongTangent), ShortTangent = Finite(spiral.ShortTangent),
                PiPoint = Point(spiral.SPIPoint), PiStationText = StationText(alignment, spiral.SPIStation)
            },
            _ => element
        };
    }

    // 설계 검토 세트에서 통과하지 못한 항목.
    private static IReadOnlyList<string>? Violations(AlignmentSubEntity sub)
    {
        try
        {
            List<string> failed = sub.DesignChecks().Where(check => !sub.ValidateDesignCheck(check))
                .Select(check => string.IsNullOrWhiteSpace(check.Description) ? check.Name : $"{check.Name}: {check.Description}")
                .ToList();
            return failed.Count > 0 ? failed : null;
        }
        catch (System.Exception) { return null; }
    }

    // 주요 측점(기하 점, PI 점)은 Civil 3D에서 받는다. 같은 측점·종류의 중복은 합친다.
    private static List<AlignmentKeyPoint> ReadKeyPoints(Alignment alignment)
    {
        IEnumerable<Station> stations = alignment.GetStationSet(StationTypes.GeometryPoint)
            .Concat(alignment.GetStationSet(StationTypes.PIPoint));
        return stations
            .Select(item => new AlignmentKeyPoint(item.GeometryStationType.ToString(), Round(item.RawStation),
                StationText(alignment, item.RawStation), Point(item.Location)))
            .GroupBy(item => (item.Type, item.Station)).Select(items => items.First())
            .OrderBy(item => item.Station).ToList();
    }

    // 편경사 임계 측점과 차로별 횡단경사(%).
    private static List<AlignmentSuperelevationStation> ReadSuperelevation(Alignment alignment)
    {
        List<AlignmentSuperelevationStation> stations = new();
        foreach (SuperelevationCurve curve in alignment.SuperelevationCurves)
            foreach (SuperelevationCriticalStation station in curve.CriticalStations)
                stations.Add(new AlignmentSuperelevationStation(curve.Name, Round(station.Station),
                    StationText(alignment, station.Station), station.StationType.ToString(), station.TransitionRegionType.ToString())
                {
                    Description = Blank(station.TransitionDescription),
                    LeftOutLanePercent = Slope(station, SuperelevationCrossSegmentType.LeftOutLaneCrossSlope),
                    LeftInLanePercent = Slope(station, SuperelevationCrossSegmentType.LeftInLaneCrossSlope),
                    RightInLanePercent = Slope(station, SuperelevationCrossSegmentType.RightInLaneCrossSlope),
                    RightOutLanePercent = Slope(station, SuperelevationCrossSegmentType.RightOutLaneCrossSlope)
                });
        return stations.OrderBy(item => item.Station).ToList();
    }

    // 경사는 비율로 온다. 1보다 크면 이미 %로 본다.
    private static double? Slope(SuperelevationCriticalStation station, SuperelevationCrossSegmentType type)
    {
        try
        {
            double value = station.GetSlope(type);
            return double.IsFinite(value) ? Math.Round(Math.Abs(value) > 1 ? value : value * 100, 3) : null;
        }
        catch (System.Exception) { return null; }
    }

    // 오프셋 선형이면 부모 선형과 오프셋 거리·방향.
    private static AlignmentOffsetInfo ReadOffset(Transaction transaction, Alignment alignment)
    {
        OffsetAlignmentInfo info = alignment.OffsetAlignmentInfo;
        Alignment? parent = info.ParentAlignmentId.IsNull ? null
            : transaction.GetObject(info.ParentAlignmentId, OpenMode.ForRead) as Alignment;
        return new AlignmentOffsetInfo(parent?.Name, parent?.Handle.ToString(), Round(info.NominalOffset), info.Side.ToString());
    }

    // 관련 객체: 종단, 종단 뷰 수, 샘플 라인 그룹, 자식 오프셋 선형.
    private static AlignmentRelated ReadRelated(Transaction transaction, Alignment alignment)
    {
        List<ProfileSummary> profiles = new();
        foreach (ObjectId id in alignment.GetProfileIds())
            if (transaction.GetObject(id, OpenMode.ForRead) is Profile profile)
                profiles.Add(AlignmentQueries.SummarizeProfile(alignment, profile));
        List<string> groups = new();
        foreach (ObjectId id in alignment.GetSampleLineGroupIds())
            if (transaction.GetObject(id, OpenMode.ForRead) is SampleLineGroup group) groups.Add(group.Name);
        List<string> children = new();
        foreach (ObjectId id in alignment.GetChildOffsetAlignmentIds())
            if (transaction.GetObject(id, OpenMode.ForRead) is Alignment child) children.Add(child.Name);
        return new AlignmentRelated(profiles, alignment.GetProfileViewIds().Count, groups, children);
    }

    // 측점 표기(측점 방정식 반영, 예 "0+120.000"). 못 구하면 숫자 그대로.
    internal static string StationText(Alignment alignment, double station)
    {
        try { return alignment.GetStationStringWithEquations(station); }
        catch (System.Exception) { return station.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture); }
    }

    private static double? Azimuth(Point2d start, Point2d end)
    {
        double dx = end.X - start.X, dy = end.Y - start.Y;
        if (dx == 0 && dy == 0) return null;
        double degrees = Math.Atan2(dx, dy) * 180 / Math.PI;
        return Math.Round(degrees < 0 ? degrees + 360 : degrees, 4);
    }

    // ── 숫자 정리(소수 4자리, 무한대·NaN은 비움)
    private static double? Degrees(double radians) => double.IsFinite(radians) ? Math.Round(Math.Abs(radians) * 180 / Math.PI, 4) : null;
    private static double[] Point(Point2d point) => [Math.Round(point.X, 4), Math.Round(point.Y, 4)];
    private static string? Blank(string? text) => string.IsNullOrWhiteSpace(text) ? null : text;
    internal static double? Finite(double value) => double.IsFinite(value) ? Math.Round(value, 4) : null;
    internal static double Round(double value) => double.IsFinite(value) ? Math.Round(value, 4) : 0;
}
