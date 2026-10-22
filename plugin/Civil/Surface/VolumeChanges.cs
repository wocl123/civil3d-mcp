using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;
using Surface = Autodesk.Civil.DatabaseServices.Surface;

namespace MyCivil3DMcp.Plugin;

internal static class VolumeChanges
{
    public static object Get(Document document, string key)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        TinVolumeSurface surface = Find(document.Database, transaction, key);
        VolumeSurfaceProperties properties = surface.GetVolumeProperties();
        return new { name = surface.Name, handle = surface.Handle.ToString(), surface.Description, layer = surface.Layer,
            style = surface.StyleName, baseSurface = Reference(transaction, properties.BaseSurface),
            comparisonSurface = Reference(transaction, properties.ComparisonSurface),
            cutFactor = properties.CutFactor, fillFactor = properties.FillFactor,
            cut = properties.UnadjustedCutVolume, fill = properties.UnadjustedFillVolume, net = properties.UnadjustedNetVolume,
            adjustedCut = properties.AdjustedCutVolume, adjustedFill = properties.AdjustedFillVolume,
            adjustedNet = properties.AdjustedNetVolume, units = CivilCoordinates.Read(document.Database) };
    }

    private static object Reference(Transaction transaction, ObjectId id)
    {
        Surface surface = (Surface)transaction.GetObject(id, OpenMode.ForRead);
        return new { name = surface.Name, handle = surface.Handle.ToString() };
    }

    private static TinVolumeSurface Find(Database database, Transaction transaction, string key) =>
        CivilObjectAccess.Find<Surface>(transaction, database, key) as TinVolumeSurface
        ?? throw new ArgumentException("TIN 토공량 지표면을 지정하세요.");

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "volume.create";
        if (create)
        {
            request["cutFactor"] ??= 1;
            request["fillFactor"] ??= 1;
        }

        TinVolumeSurface? surface = create ? null : Find(database, transaction, CivilObjectAccess.Text(request, "surface"));
        if (surface is not null)
        {
            CivilObjectAccess.Editable(surface);
            CivilObjectAccess.WritableLayer(transaction, surface.LayerId);
            if (surface.Lock)
            {
                throw new ArgumentException("토공량 지표면이 잠겨 있습니다.");
            }

            request["surface"] = surface.Handle.ToString();
            request["targetFingerprint"] = surface.ComputeFingerPrint().ToString("X");
            details.Add($"대상: {surface.Name} [{surface.Handle}], 절토 계수 {surface.CutFactor}, 성토 계수 {surface.FillFactor}");
        }

        ValidateName(database, transaction, request, surface, create, details);
        CivilPropertyChanges.Validate(database, transaction, request, surface, "surface", details);
        if (create || request["layer"] is not null)
        {
            CivilObjectAccess.WritableLayer(transaction, CivilObjectAccess.Layer(transaction, database, request["layer"]?.ToString()));
        }

        ValidateFactors(request, details);
        if (create)
        {
            ValidateSources(database, transaction, request, details);
        }
        else
        {
            bool hasChanges = new[] { "newName", "description", "style", "layer", "cutFactor", "fillFactor", "rebuild" }
                .Any(key => request[key] is not null && (key != "rebuild" || request[key]!.GetValue<bool>()));
            if (!hasChanges)
            {
                throw new ArgumentException("변경할 토공량 지표면 속성을 지정하세요.");
            }
        }

        details.Add("기준 지표면과 비교 지표면은 변경하지 않습니다. 체적은 도면 길이 단위의 세제곱입니다.");
        return create ? $"TIN 토공량 지표면 {request["name"]} 생성" : $"토공량 지표면 {surface!.Name} 수정";
    }

    private static void ValidateName(Database database, Transaction transaction, JsonObject request,
        TinVolumeSurface? surface, bool create, List<string> details)
    {
        string key = create ? "name" : "newName";
        if (create || request[key] is not null)
        {
            string name = CivilObjectAccess.Text(request, key);
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ArgumentException("토공량 지표면 이름이 필요합니다.");
            }

            CivilObjectAccess.FreeName<Surface>(transaction, database, name, surface?.ObjectId ?? ObjectId.Null);
            details.Add($"이름: {surface?.Name ?? "(새 지표면)"} → {name}");
        }
    }

    private static void ValidateFactors(JsonObject request, List<string> details)
    {
        foreach (string key in new[] { "cutFactor", "fillFactor" })
        {
            if (request[key] is null)
            {
                continue;
            }

            double value = CivilObjectAccess.Number(request[key]);
            if (value <= 0)
            {
                throw new ArgumentException("절성토 계수는 0보다 커야 합니다.");
            }

            details.Add($"{(key == "cutFactor" ? "절토" : "성토")} 계수 → {value}");
        }
    }

    private static void ValidateSources(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        List<TinSurface> sources = new();
        JsonObject state = new();
        foreach (string key in new[] { "baseSurface", "comparisonSurface" })
        {
            TinSurface source = CivilObjectAccess.Find<Surface>(transaction, database,
                CivilObjectAccess.Text(request, key)) as TinSurface
                ?? throw new ArgumentException("기준·비교 지표면은 일반 TIN 지표면이어야 합니다.");
            bool invalidReference = source.IsReferenceObject && (!source.IsReferenceValid || source.IsReferenceStale);
            if (source.GetTinProperties().NumberOfTriangles < 1 || invalidReference)
            {
                throw new ArgumentException($"'{source.Name}'은 유효한 삼각망이 없거나 오래된 참조입니다.");
            }

            request[key] = source.Handle.ToString();
            state[key] = source.ComputeFingerPrint().ToString("X");
            details.Add($"{(key == "baseSurface" ? "기준" : "비교")}: {source.Name} [{source.Handle}]");
            sources.Add(source);
        }

        if (sources[0].ObjectId == sources[1].ObjectId)
        {
            throw new ArgumentException("기준·비교 지표면을 서로 다르게 지정하세요.");
        }

        Extents3d first = sources[0].GeometricExtents;
        Extents3d second = sources[1].GeometricExtents;
        bool overlaps = Math.Min(first.MaxPoint.X, second.MaxPoint.X) > Math.Max(first.MinPoint.X, second.MinPoint.X)
            && Math.Min(first.MaxPoint.Y, second.MaxPoint.Y) > Math.Max(first.MinPoint.Y, second.MinPoint.Y);
        if (!overlaps)
        {
            throw new ArgumentException("기준·비교 지표면의 XY 범위가 겹치지 않습니다.");
        }

        request["sourceState"] = state;
        details.Add("XY 범위 겹침을 확인했습니다. 실제 공통 삼각망은 적용 시 검사하며 없으면 전체 생성을 취소합니다.");
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        bool create = CivilObjectAccess.Text(request, "operation") == "volume.create";
        TinVolumeSurface surface;
        if (create)
        {
            ObjectId style = CivilObjectAccess.Style(transaction, database, "surface", request["style"]?.ToString());
            ObjectId baseline = CivilObjectAccess.Find<Surface>(transaction, database,
                CivilObjectAccess.Text(request, "baseSurface")).ObjectId;
            ObjectId comparison = CivilObjectAccess.Find<Surface>(transaction, database,
                CivilObjectAccess.Text(request, "comparisonSurface")).ObjectId;
            ObjectId id = TinVolumeSurface.Create(CivilObjectAccess.Text(request, "name"), baseline, comparison, style);
            surface = (TinVolumeSurface)transaction.GetObject(id, OpenMode.ForWrite);
        }
        else
        {
            surface = Find(database, transaction, CivilObjectAccess.Text(request, "surface"));
            surface = (TinVolumeSurface)transaction.GetObject(surface.ObjectId, OpenMode.ForWrite);
        }

        CivilPropertyChanges.Apply(database, transaction, request, surface, "surface");
        if (request["cutFactor"] is not null)
        {
            surface.CutFactor = CivilObjectAccess.Number(request["cutFactor"]);
        }

        if (request["fillFactor"] is not null)
        {
            surface.FillFactor = CivilObjectAccess.Number(request["fillFactor"]);
        }

        surface.Rebuild();
        if (surface.GetTinProperties().NumberOfTriangles < 1)
        {
            throw new InvalidOperationException("공통 삼각망이 없어 토공량 지표면 작업을 취소했습니다.");
        }

        VolumeSurfaceProperties values = surface.GetVolumeProperties();
        return new { name = surface.Name, handle = surface.Handle.ToString(), cut = values.UnadjustedCutVolume,
            fill = values.UnadjustedFillVolume, adjustedCut = values.AdjustedCutVolume, adjustedFill = values.AdjustedFillVolume,
            cutFactor = values.CutFactor, fillFactor = values.FillFactor };
    }
}
