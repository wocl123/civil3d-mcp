using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 종단 하나에서 읽는 모든 것을 구간(section)별로 묶은 것.
/// K값, 최고·최저점, 시거처럼 Civil 3D가 계산한 값은 다시 계산하지 않고 읽는다.
/// 경사는 비율에서 %로 바꾼다.
/// </summary>
internal sealed class ProfileSnapshot
{
    private const int MaxSamples = 200;

    public required ProfileOverview Overview { get; init; }
    public required IReadOnlyList<ProfilePvi> Pvis { get; init; }
    public required IReadOnlyList<ProfileTangentInfo> Tangents { get; init; }
    public required IReadOnlyList<ProfileCurveInfo> Curves { get; init; }
    public required IReadOnlyList<ProfileViewInfo> Views { get; init; }

    public static readonly string[] SectionNames = ["pvis", "tangents", "curves", "views", "design_checks", "elevations"];

    public static ProfileSnapshot Read(Transaction transaction, Alignment alignment, Profile profile)
    {
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

        bool checks = Try("settings", () => profile.UseDesignCheckSet);
        // 튜플은 null이 될 수 없어서, 읽기 실패를 nullable 튜플로 표시한다.
        // 이렇게 하지 않으면 실패 때 (null, null)이 되어 다음 줄에서 "Value cannot be null"이 났다.
        (List<ProfileTangentInfo> tangents, List<ProfileCurveInfo> curves) =
            Try<(List<ProfileTangentInfo>, List<ProfileCurveInfo>)?>("entities", () => ReadEntities(alignment, profile, checks)) ?? (new(), new());
        List<ProfilePvi> pvis = Try("pvis", () => ReadPvis(alignment, profile)) ?? new();
        List<ProfileViewInfo> views = Try("views", () => ReadViews(transaction, alignment)) ?? new();
        ProfileSettings settings = Try("settings", () => ReadSettings(transaction, profile))
            ?? new ProfileSettings("Unknown", null, null, null, false, false, false, null);

        // 최고·최저 표고는 경사구간·곡선의 끝점과 곡선의 최고·최저점에서 구한다.
        List<ProfilePoint> candidates = tangents.SelectMany(item => new[]
        {
            new ProfilePoint(item.StartStation, item.StartStationText, item.StartElevation),
            new ProfilePoint(item.EndStation, item.EndStationText, item.EndElevation)
        }).ToList();
        candidates.AddRange(curves.Select(item => item.HighLowPoint).OfType<ProfilePoint>());

        int violations = tangents.Sum(item => item.DesignViolations?.Count ?? 0) + curves.Sum(item => item.DesignViolations?.Count ?? 0);
        Dictionary<string, int> sections = new()
        {
            ["pvis"] = pvis.Count,
            ["tangents"] = tangents.Count,
            ["curves"] = curves.Count,
            ["views"] = views.Count,
            ["design_checks"] = violations,
            ["elevations"] = 0
        };
        if (!checks) unavailable.Add("design_checks: the profile does not use a design check set.");

        return new ProfileSnapshot
        {
            Overview = new ProfileOverview(AlignmentQueries.SummarizeProfile(alignment, profile), settings,
                candidates.MaxBy(item => item.Elevation), candidates.MinBy(item => item.Elevation), sections, unavailable),
            Pvis = pvis, Tangents = tangents, Curves = curves, Views = views
        };
    }

    /// <summary>구간 하나의 항목. 측점 범위를 주면 그 안의 것만. 표고(elevations)는 Sample로 읽는다.</summary>
    public IEnumerable<object> Section(string name, double? from, double? to)
    {
        bool Overlaps(double start, double end) => (from is null || end >= from) && (to is null || start <= to);
        bool Within(double station) => (from is null || station >= from) && (to is null || station <= to);
        return name switch
        {
            "pvis" => Pvis.Where(item => Within(item.Station)),
            "tangents" => Tangents.Where(item => Overlaps(item.StartStation, item.EndStation)),
            "curves" => Curves.Where(item => Overlaps(item.StartStation, item.EndStation)),
            "views" => Views,
            "design_checks" => Tangents.Where(item => item.DesignViolations is { Count: > 0 } && Overlaps(item.StartStation, item.EndStation)).Cast<object>()
                .Concat(Curves.Where(item => item.DesignViolations is { Count: > 0 } && Overlaps(item.StartStation, item.EndStation))),
            _ => throw new ArgumentException($"Unknown section '{name}'. Use one of: {string.Join(", ", SectionNames)}.")
        };
    }

    // 측점을 주면 그대로 쓰고, 아니면 범위를 간격(interval)으로 나눈다.
    public double[] SampleStations(double? from, double? to, double[] stations, double? interval)
    {
        if (stations.Length > 0) return stations.Take(MaxSamples).ToArray();
        if (interval is not > 0)
            throw new ArgumentException("For elevations, give stations or an interval greater than zero.");
        double start = from ?? Overview.Profile.StartStation, end = to ?? Overview.Profile.EndStation;
        List<double> result = new();
        for (double station = start; station <= end + 1e-9 && result.Count < MaxSamples; station += interval.Value)
            result.Add(Math.Round(station, 4));
        if (result.Count < MaxSamples && result[^1] < end - 1e-6) result.Add(end);
        return result.ToArray();
    }

    // 표고는 이번 요청에서 연 종단에서 읽는다. 스냅숏에는 값만 둔다:
    // 도면 객체는 트랜잭션이 끝나면 닫히기 때문.
    public static IEnumerable<object> Sample(Alignment alignment, Profile profile, double[] stations) => stations.Select(station =>
    {
        double? elevation = null, grade = null;
        try { elevation = AlignmentSnapshot.Finite(profile.ElevationAt(station)); } catch (System.Exception) { }
        try { grade = Percent(profile.GradeAt(station)); } catch (System.Exception) { }
        return (object)new ProfileSample(AlignmentSnapshot.Round(station), AlignmentSnapshot.StationText(alignment, station), elevation, grade);
    }).ToList();

    // 경사구간(tangent)과 종단곡선. 경사는 %, 곡선은 K·길이·시거 등.
    private static (List<ProfileTangentInfo>, List<ProfileCurveInfo>) ReadEntities(Alignment alignment, Profile profile, bool checks)
    {
        List<ProfileTangentInfo> tangents = new();
        List<ProfileCurveInfo> curves = new();
        foreach (ProfileEntity entity in profile.Entities.Cast<ProfileEntity>().OrderBy(item => item.StartStation))
        {
            IReadOnlyList<string>? violations = checks ? Violations(entity) : null;
            if (entity is ProfileTangent tangent)
            {
                tangents.Add(new ProfileTangentInfo(tangents.Count + 1, R(tangent.StartStation), R(tangent.EndStation),
                    Text(alignment, tangent.StartStation), Text(alignment, tangent.EndStation),
                    R(tangent.StartElevation), R(tangent.EndElevation), R(tangent.Length), Percent(tangent.Grade))
                { DesignViolations = violations });
                continue;
            }
            ProfileCurveInfo? curve = entity switch
            {
                ProfileCircular circular => Curve(alignment, entity, curves.Count + 1, "Circular", circular.CurveType,
                    circular.PVIStation, circular.PVIElevation, circular.GradeIn, circular.GradeOut, circular.GradeChange, circular.K,
                    circular.HighLowPointStation, circular.HighLowPointElevation, circular.TangentOffsetAtPVI) with
                { Radius = AlignmentSnapshot.Finite(circular.Radius), MiddleOrdinate = AlignmentSnapshot.Finite(circular.M) },
                ProfileParabolaSymmetric symmetric => Curve(alignment, entity, curves.Count + 1, "ParabolaSymmetric", symmetric.CurveType,
                    symmetric.PVIStation, symmetric.PVIElevation, symmetric.GradeIn, symmetric.GradeOut, symmetric.GradeChange, symmetric.K,
                    symmetric.HighLowPointStation, symmetric.HighLowPointElevation, symmetric.TangentOffsetAtPVI) with
                { Radius = AlignmentSnapshot.Finite(symmetric.Radius), MiddleOrdinate = AlignmentSnapshot.Finite(symmetric.M) },
                ProfileParabolaAsymmetric asymmetric => Curve(alignment, entity, curves.Count + 1, "ParabolaAsymmetric", asymmetric.CurveType,
                    asymmetric.PVIStation, asymmetric.PVIElevation, asymmetric.GradeIn, asymmetric.GradeOut, asymmetric.GradeChange, asymmetric.K,
                    asymmetric.HighLowPointStation, asymmetric.HighLowPointElevation, asymmetric.TangentOffsetAtPVI) with
                {
                    AsymmetricLength1 = AlignmentSnapshot.Finite(asymmetric.AsymmetricLength1),
                    AsymmetricLength2 = AlignmentSnapshot.Finite(asymmetric.AsymmetricLength2)
                },
                _ => null
            };
            if (curve is not null) curves.Add(curve with { DesignViolations = violations });
        }
        return (tangents, curves);
    }

    private static ProfileCurveInfo Curve(Alignment alignment, ProfileEntity entity, int number, string type,
        VerticalCurveType crestOrSag, double pviStation, double pviElevation, double gradeIn, double gradeOut,
        double gradeChange, double k, double highLowStation, double highLowElevation, double tangentOffset)
    {
        // 최고·최저점은 곡선 위에 있을 때만 알려 준다.
        bool onCurve = double.IsFinite(highLowStation) && double.IsFinite(highLowElevation) &&
            highLowStation >= entity.StartStation - 1e-6 && highLowStation <= entity.EndStation + 1e-6;
        return new ProfileCurveInfo(number, type, crestOrSag.ToString(), R(entity.StartStation), R(entity.EndStation),
            Text(alignment, entity.StartStation), Text(alignment, entity.EndStation), R(entity.Length),
            R(pviStation), Text(alignment, pviStation), R(pviElevation),
            Percent(gradeIn), Percent(gradeOut), Percent(gradeChange), AlignmentSnapshot.Finite(k))
        {
            TangentOffsetAtPvi = AlignmentSnapshot.Finite(tangentOffset),
            HighLowPoint = onCurve ? new ProfilePoint(R(highLowStation), Text(alignment, highLowStation), R(highLowElevation)) : null,
            // 설계 기준이 없는 곡선에서는 Civil 3D가 이 값들에 예외를 낸다.
            MinimumKStopping = Optional(() => entity.MinimumKValueSSD),
            MinimumKPassing = Optional(() => entity.MinimumKValuePSD),
            MinimumKHeadlight = Optional(() => entity.MinimumKValueHSD),
            HighestDesignSpeed = Optional(() => entity.HighestDesignSpeed)
        };
    }

    // PVI 목록: 측점, 표고, 앞뒤 경사, 곡선.
    private static List<ProfilePvi> ReadPvis(Alignment alignment, Profile profile)
    {
        List<ProfilePvi> pvis = new();
        foreach (ProfilePVI pvi in profile.PVIs.Cast<ProfilePVI>().OrderBy(item => item.RawStation))
        {
            ProfileEntity? curve = null;
            try { curve = pvi.VerticalCurve; } catch (System.Exception) { }
            pvis.Add(new ProfilePvi(pvis.Count + 1, R(pvi.RawStation), Text(alignment, pvi.RawStation), R(pvi.Elevation),
                Percent(pvi.GradeIn), Percent(pvi.GradeOut), pvi.PVIType.ToString())
            {
                GradeChangePercent = double.IsFinite(pvi.GradeIn) && double.IsFinite(pvi.GradeOut)
                    ? Percent(pvi.GradeOut - pvi.GradeIn) : null,
                CurveLength = curve is null ? null : AlignmentSnapshot.Finite(curve.Length),
                K = curve switch
                {
                    ProfileCircular item => AlignmentSnapshot.Finite(item.K),
                    ProfileParabolaSymmetric item => AlignmentSnapshot.Finite(item.K),
                    ProfileParabolaAsymmetric item => AlignmentSnapshot.Finite(item.K),
                    _ => null
                },
                CrestOrSag = curve switch
                {
                    ProfileCircular item => item.CurveType.ToString(),
                    ProfileParabolaSymmetric item => item.CurveType.ToString(),
                    ProfileParabolaAsymmetric item => item.CurveType.ToString(),
                    _ => null
                },
                StoppingSightDistance = Positive(pvi.StoppingSightDistance),
                PassingSightDistance = Positive(pvi.PassingSightDistance),
                HeadlightSightDistance = Positive(pvi.HeadlightSightDistance)
            });
        }
        return pvis;
    }

    // 이 선형의 종단 뷰들.
    private static List<ProfileViewInfo> ReadViews(Transaction transaction, Alignment alignment)
    {
        List<ProfileViewInfo> views = new();
        foreach (ObjectId id in alignment.GetProfileViewIds())
            if (transaction.GetObject(id, OpenMode.ForRead) is ProfileView view)
                views.Add(new ProfileViewInfo(view.Name, view.Handle.ToString(), R(view.StationStart), R(view.StationEnd),
                    Text(alignment, view.StationStart), Text(alignment, view.StationEnd), R(view.ElevationMin), R(view.ElevationMax))
                { Style = view.StyleName });
        return views;
    }

    // 종단 설정(설계 기준 파일, 검토 세트 등).
    private static ProfileSettings ReadSettings(Transaction transaction, Profile profile)
    {
        double? offset = null;
        string? parent = null;
        if (profile.ProfileType == ProfileType.OffsetProfile)
        {
            try { offset = AlignmentSnapshot.Finite(profile.Offset); } catch (System.Exception) { }
            try
            {
                ObjectId parentId = profile.OffsetParameters.ParentProfileId;
                if (!parentId.IsNull && transaction.GetObject(parentId, OpenMode.ForRead) is Profile source) parent = source.Name;
            }
            catch (System.Exception) { }
        }
        return new ProfileSettings(profile.UpdateMode.ToString(),
            string.IsNullOrWhiteSpace(profile.DataSourceName) ? null : profile.DataSourceName, offset, parent,
            profile.DesignSpeedBased, profile.UseDesignCriteriaFile, profile.UseDesignCheckSet,
            string.IsNullOrWhiteSpace(profile.DesignCheckSetName) ? null : profile.DesignCheckSetName);
    }

    // 설계 검토 세트에서 통과하지 못한 항목.
    private static IReadOnlyList<string>? Violations(ProfileEntity entity)
    {
        try
        {
            List<string> failed = entity.DesignChecks()
                .Where(check => !entity.ValidateDesignCheck(check, ProfileApplyCurveType.CrestAndSag))
                .Select(check => string.IsNullOrWhiteSpace(check.Description) ? check.Name : $"{check.Name}: {check.Description}")
                .ToList();
            return failed.Count > 0 ? failed : null;
        }
        catch (System.Exception) { return null; }
    }

    // Civil 3D는 경사를 비율로 준다. 답은 %로.
    internal static double? Percent(double ratio) => double.IsFinite(ratio) ? Math.Round(ratio * 100, 4) : null;
    private static double? Optional(Func<double> read)
    {
        try { return Positive(read()); } catch (System.Exception) { return null; }
    }

    private static double? Positive(double value) => double.IsFinite(value) && value > 0 ? Math.Round(value, 4) : null;
    private static double R(double value) => AlignmentSnapshot.Round(value);
    private static string Text(Alignment alignment, double station) => AlignmentSnapshot.StationText(alignment, station);
}
