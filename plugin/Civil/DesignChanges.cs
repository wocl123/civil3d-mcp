using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;
using DBObject = Autodesk.AutoCAD.DatabaseServices.DBObject;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Applies computed design fixes to the drawing. The only code that writes Civil objects.
/// Every change first checks that the value is still what the fix was computed from;
/// if any check or change fails, nothing is committed. All changes are one undo step.
/// </summary>
internal static class DesignChanges
{
    private const double StationTolerance = 0.01;
    private const double ValueTolerance = 0.001;

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

    private static DesignChangeResult ApplyOne(Transaction transaction, Database database, DesignChangeRequest request)
    {
        DBObject target = Open(transaction, database, request.Handle);
        (Func<double> read, Action<double> write) = (request.Kind, request.Property, target) switch
        {
            ("profilePvi", "elevation", Profile profile) => Accessor(Pvi(profile, request), pvi => pvi.Elevation, (pvi, value) => pvi.Elevation = value),
            ("profileCurve", "length", Profile profile) => Accessor(Curve(profile, request), curve => curve.Length, (curve, value) => curve.Length = value),
            ("alignmentArc", "radius", Alignment alignment) => Accessor(Arc(alignment, request), arc => arc.Radius, (arc, value) => arc.Radius = value),
            _ => throw new NotSupportedException($"{request.Kind}.{request.Property} 변경은 아직 자동으로 적용할 수 없습니다.")
        };
        double before = read();
        if (request.From is double expected && Math.Abs(before - expected) > ValueTolerance)
            throw new InvalidOperationException(
                $"{request.Kind} {request.Property} 값이 {Round(before)}로 바뀌어 있어 적용하지 않았습니다(수정안 기준 {Round(expected)}). 다시 검토하세요.");
        write(request.To);
        double after = read();
        if (Math.Abs(after - request.To) > ValueTolerance)
            throw new InvalidOperationException(
                $"{request.Kind} {request.Property}를 {Round(request.To)}로 바꾸지 못했습니다(Civil 3D 결과 {Round(after)}). 고정 조건이 걸린 요소일 수 있습니다.");
        return new DesignChangeResult(request.Kind, request.Handle, request.At, request.Property, Round(before), Round(after));
    }

    private static (Func<double>, Action<double>) Accessor<T>(T item, Func<T, double> get, Action<T, double> set) =>
        (() => get(item), value => set(item, value));

    private static DBObject Open(Transaction transaction, Database database, string handle)
    {
        if (!long.TryParse(handle, System.Globalization.NumberStyles.HexNumber, null, out long value) ||
            !database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased)
            throw new ArgumentException($"Object {handle} was not found.");
        return transaction.GetObject(id, OpenMode.ForWrite);
    }

    private static double At(DesignChangeRequest request) =>
        request.At ?? throw new ArgumentException($"{request.Kind} needs a station.");

    private static ProfilePVI Pvi(Profile profile, DesignChangeRequest request)
    {
        double station = At(request);
        return profile.PVIs.Cast<ProfilePVI>().FirstOrDefault(pvi => Math.Abs(pvi.RawStation - station) < StationTolerance)
            ?? throw new ArgumentException($"No PVI at station {station} in profile {profile.Name}.");
    }

    private static ProfileEntity Curve(Profile profile, DesignChangeRequest request) =>
        Pvi(profile, request).VerticalCurve ?? throw new ArgumentException($"The PVI at {At(request)} has no vertical curve.");

    // Only a single arc entity can take a new radius here; arcs inside spiral groups are not changed.
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
