using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;
using DBObject = Autodesk.AutoCAD.DatabaseServices.DBObject;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 계산한 설계 수정안을 도면에 적용한다. Civil 객체 값을 바꾸는 코드는 여기(와 AlignmentCreation)뿐이다.
/// 바꾸기 전에 지금 값이 수정안을 계산할 때의 값(From)과 같은지 확인하고,
/// 하나라도 확인·변경에 실패하면 아무것도 커밋하지 않는다. 모든 변경은 Undo 한 번으로 되돌린다.
/// </summary>
internal static class DesignChanges
{
    private const double StationTolerance = 0.01;   // 측점으로 요소를 찾을 때 허용 차(m)
    private const double ValueTolerance = 0.001;    // 값 비교 허용 차

    public static DesignChangeOutcome Apply(Document document, IReadOnlyList<DesignChangeRequest> requests)
    {
        if (requests.Count == 0) throw new ArgumentException("No changes were given.");
        Database database = document.Database;
        List<DesignChangeResult> results = new();
        using (Transaction transaction = database.TransactionManager.StartTransaction())
        {
            foreach (DesignChangeRequest request in requests)
                results.Add(ApplyOne(transaction, database, request));
            transaction.Commit();
        }
        return new DesignChangeOutcome(results, DrawingRevisions.Of(database));
    }

    // 변경 하나: 대상 찾기 → 지금 값 확인 → 쓰기 → 다시 읽어 확인.
    private static DesignChangeResult ApplyOne(Transaction transaction, Database database, DesignChangeRequest request)
    {
        DBObject target = Open(transaction, database, request.Handle);
        (Func<double> read, Action<double> write) = (request.Kind, request.Property, target) switch
        {
            // 종단 PVI 표고
            ("profilePvi", "elevation", Profile profile) =>
                Accessor(Pvi(profile, request), pvi => pvi.Elevation, (pvi, value) => pvi.Elevation = value),
            // 종단곡선 길이
            ("profileCurve", "length", Profile profile) =>
                Accessor(Curve(profile, request), curve => curve.Length, (curve, value) => curve.Length = value),
            // 평면 원곡선 반지름
            ("alignmentArc", "radius", Alignment alignment) =>
                Accessor(Arc(alignment, request), arc => arc.Radius, (arc, value) => arc.Radius = value),
            _ => throw new NotSupportedException($"{request.Kind}.{request.Property} 변경은 아직 자동으로 적용할 수 없습니다.")
        };

        // 계획 뒤에 사람이 값을 바꿨으면 적용하지 않는다.
        double before = read();
        if (request.From is double expected && Math.Abs(before - expected) > ValueTolerance)
            throw new InvalidOperationException(
                $"{request.Kind} {request.Property} 값이 {Round(before)}로 바뀌어 있어 적용하지 않았습니다(수정안 기준 {Round(expected)}). 다시 검토하세요.");

        // Civil 3D가 다른 값으로 맞춰 버리면(고정 조건 등) 실패로 본다.
        write(request.To);
        double after = read();
        if (Math.Abs(after - request.To) > ValueTolerance)
            throw new InvalidOperationException(
                $"{request.Kind} {request.Property}를 {Round(request.To)}로 바꾸지 못했습니다(Civil 3D 결과 {Round(after)}). 고정 조건이 걸린 요소일 수 있습니다.");
        return new DesignChangeResult(request.Kind, request.Handle, request.At, request.Property, Round(before), Round(after));
    }

    // 요소 하나의 읽기/쓰기 짝.
    private static (Func<double>, Action<double>) Accessor<T>(T item, Func<T, double> get, Action<T, double> set) =>
        (() => get(item), value => set(item, value));

    // 핸들로 객체를 쓰기 모드로 연다.
    private static DBObject Open(Transaction transaction, Database database, string handle)
    {
        if (!long.TryParse(handle, System.Globalization.NumberStyles.HexNumber, null, out long value) ||
            !database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased)
            throw new ArgumentException($"Object {handle} was not found.");
        return transaction.GetObject(id, OpenMode.ForWrite);
    }

    private static double At(DesignChangeRequest request) =>
        request.At ?? throw new ArgumentException($"{request.Kind} needs a station.");

    // 측점에 있는 PVI.
    private static ProfilePVI Pvi(Profile profile, DesignChangeRequest request)
    {
        double station = At(request);
        return profile.PVIs.Cast<ProfilePVI>().FirstOrDefault(pvi => Math.Abs(pvi.RawStation - station) < StationTolerance)
            ?? throw new ArgumentException($"No PVI at station {station} in profile {profile.Name}.");
    }

    private static ProfileEntity Curve(Profile profile, DesignChangeRequest request) =>
        Pvi(profile, request).VerticalCurve ?? throw new ArgumentException($"The PVI at {At(request)} has no vertical curve.");

    // 그 측점에서 시작하는 단독 원곡선. 완화곡선 묶음(SCS) 안의 원곡선은 여기서 바꾸지 않는다.
    private static AlignmentArc Arc(Alignment alignment, DesignChangeRequest request)
    {
        double station = At(request);
        for (int index = 0; index < alignment.Entities.Count; index++)
            if (alignment.Entities.GetEntityByOrder(index) is AlignmentArc arc && Math.Abs(arc.StartStation - station) < StationTolerance)
                return arc;
        throw new ArgumentException($"No single arc starts at station {station} in alignment {alignment.Name}.");
    }

    private static double Round(double value) => Math.Round(value, 4);
}
