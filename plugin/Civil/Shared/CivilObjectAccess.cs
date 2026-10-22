using System.Globalization;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using CivilEntity = Autodesk.Civil.DatabaseServices.Entity;
using Surface = Autodesk.Civil.DatabaseServices.Surface;
using Entity = Autodesk.AutoCAD.DatabaseServices.Entity;

namespace MyCivil3DMcp.Plugin;

// 조회와 계획·적용이 같은 방식으로 객체·스타일·레이어를 찾는다.
internal static class CivilObjectAccess
{
    public static string Text(JsonObject request, string key) =>
        request[key]?.GetValue<string>() ?? throw new ArgumentException($"{key} 값이 필요합니다.");

    public static double Number(JsonNode? node)
    {
        if (node is null || node.GetValueKind() != System.Text.Json.JsonValueKind.Number
            || !double.TryParse(node.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out double value)
            || !double.IsFinite(value))
        {
            throw new ArgumentException("유한한 숫자만 사용할 수 있습니다.");
        }

        return value;
    }

    public static IEnumerable<T> All<T>(Transaction transaction, Database database) where T : CivilEntity
    {
        CivilDocument civil = CivilDocument.GetCivilDocument(database);
        IEnumerable<ObjectId> ids;
        if (typeof(T) == typeof(Alignment))
        {
            ids = civil.GetAlignmentIds().Cast<ObjectId>();
        }
        else if (typeof(T) == typeof(Profile))
        {
            ids = All<Alignment>(transaction, database).SelectMany(item => item.GetProfileIds().Cast<ObjectId>());
        }
        else if (typeof(T) == typeof(Network))
        {
            ids = civil.GetPipeNetworkIds().Cast<ObjectId>();
        }
        else if (typeof(T) == typeof(ProfileView))
        {
            ids = All<Alignment>(transaction, database).SelectMany(item => item.GetProfileViewIds().Cast<ObjectId>());
        }
        else
        {
            ids = civil.GetSurfaceIds().Cast<ObjectId>();
        }

        return ids.Where(id => !id.IsErased).Select(id => transaction.GetObject(id, OpenMode.ForRead)).OfType<T>();
    }

    public static T Find<T>(Transaction transaction, Database database, string key) where T : CivilEntity
    {
        T[] matches = All<T>(transaction, database)
            .Where(item => item.Handle.ToString().Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        if (matches.Length == 0)
        {
            matches = All<T>(transaction, database)
                .Where(item => item.Name.Equals(key, StringComparison.OrdinalIgnoreCase)).ToArray();
        }

        if (matches.Length != 1)
        {
            throw new ArgumentException($"{typeof(T).Name} '{key}': 대상이 없거나 이름이 중복됩니다. 핸들을 사용하세요.");
        }

        return matches[0];
    }

    public static void Editable(CivilEntity entity)
    {
        if (entity.IsReferenceObject || entity.IsReferenceSubObject)
        {
            throw new ArgumentException("참조 Civil 객체는 원본 도면에서 수정·삭제하세요.");
        }
    }

    public static void FreeName<T>(Transaction transaction, Database database, string name,
        ObjectId except = default, ObjectId alignment = default) where T : CivilEntity
    {
        SymbolUtilityServices.ValidateSymbolName(name, false);
        bool taken = All<T>(transaction, database).Any(item => item.ObjectId != except
            && (item is not Profile profile || alignment.IsNull || profile.AlignmentId == alignment)
            && item.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        if (taken)
        {
            throw new ArgumentException($"'{name}' 이름이 이미 있습니다.");
        }
    }

    public static ObjectId Layer(Transaction transaction, Database database, string? name)
    {
        if (name is null)
        {
            return database.Clayer;
        }

        LayerTable table = (LayerTable)transaction.GetObject(database.LayerTableId, OpenMode.ForRead);
        if (!table.Has(name))
        {
            throw new ArgumentException($"레이어 '{name}'이 없습니다.");
        }

        LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(table[name], OpenMode.ForRead);
        if (layer.IsDependent)
        {
            throw new ArgumentException("외부참조 레이어는 사용할 수 없습니다.");
        }

        return layer.ObjectId;
    }

    public static void WritableLayer(Transaction transaction, ObjectId id)
    {
        LayerTableRecord layer = (LayerTableRecord)transaction.GetObject(id, OpenMode.ForRead);
        if (layer.IsLocked || layer.IsDependent)
        {
            throw new ArgumentException($"레이어 '{layer.Name}'이 잠겼거나 외부참조입니다.");
        }
    }

    public static ObjectId Style(Transaction transaction, Database database, string kind, string? name)
    {
        IEnumerable<ObjectId> ids = StyleIds(database, kind);
        List<(ObjectId Id, string Name)> styles = ids.Select(id =>
            (id, ((Autodesk.Civil.DatabaseServices.Styles.StyleBase)transaction.GetObject(id, OpenMode.ForRead)).Name))
            .ToList();
        if (name is null && styles.Count > 0)
        {
            return styles[0].Id;
        }

        foreach ((ObjectId id, string label) in styles)
        {
            if (label.Equals(name, StringComparison.OrdinalIgnoreCase)
                || id.Handle.ToString().Equals(name, StringComparison.OrdinalIgnoreCase))
            {
                return id;
            }
        }

        throw new ArgumentException($"스타일 '{name}'이 없습니다. 사용 가능: {string.Join(", ", styles.Select(s => s.Name))}");
    }

    internal static IEnumerable<ObjectId> StyleIds(Database database, string kind)
    {
        var styles = CivilDocument.GetCivilDocument(database).Styles;
        return kind switch
        {
            "surface" => styles.SurfaceStyles.Cast<ObjectId>(),
            "alignment" => styles.AlignmentStyles.Cast<ObjectId>(),
            "alignmentLabels" => styles.LabelSetStyles.AlignmentLabelSetStyles.Cast<ObjectId>(),
            "sampleLine" => styles.SampleLineStyles.Cast<ObjectId>(),
            "section" => styles.SectionStyles.Cast<ObjectId>(),
            "sectionView" => styles.SectionViewStyles.Cast<ObjectId>(),
            "assembly" => styles.AssemblyStyles.Cast<ObjectId>(),
            "codeSet" => styles.CodeSetStyles.Cast<ObjectId>(),
            "profile" => styles.ProfileStyles.Cast<ObjectId>(),
            "profileView" => styles.ProfileViewStyles.Cast<ObjectId>(),
            "profileLabels" => styles.LabelSetStyles.ProfileLabelSetStyles.Cast<ObjectId>(),
            "point" => styles.PointStyles.Cast<ObjectId>(),
            "pointLabel" => styles.LabelStyles.PointLabelStyles.LabelStyles.Cast<ObjectId>(),
            "pipe" => styles.PipeStyles.Cast<ObjectId>(),
            "structure" => styles.StructureStyles.Cast<ObjectId>(),
            "featureLine" => styles.FeatureLineStyles.Cast<ObjectId>(),
            "catchment" => styles.CatchmentStyles.Cast<ObjectId>(),
            "surfaceElevationLabel" => styles.LabelStyles.SurfaceLabelStyles.SpotElevationLabelStyles.Cast<ObjectId>(),
            "surfaceSlopeLabel" => styles.LabelStyles.SurfaceLabelStyles.SlopeLabelStyles.Cast<ObjectId>(),
            "generalLineLabel" => styles.LabelStyles.GeneralLineLabelStyles.Cast<ObjectId>(),
            "generalCurveLabel" => styles.LabelStyles.GeneralCurveLabelStyles.Cast<ObjectId>(),
            "noteLabel" => styles.LabelStyles.GeneralNoteLabelStyles.Cast<ObjectId>(),
            "marker" => styles.MarkerStyles.Cast<ObjectId>(),
            "stationOffsetLabel" => styles.LabelStyles.AlignmentLabelStyles.StationOffsetLabelStyles.Cast<ObjectId>(),
            "stationElevationLabel" => styles.LabelStyles.ProfileViewLabelStyles.StationElevationLabelStyles.Cast<ObjectId>(),
            "offsetElevationLabel" => styles.LabelStyles.SectionViewLabelStyles.OffsetElevationLabelStyles.Cast<ObjectId>(),
            "pipeLabel" => styles.LabelStyles.PipeLabelStyles.PlanProfileLabelStyles.Cast<ObjectId>(),
            "structureLabel" => styles.LabelStyles.StructureLabelStyles.LabelStyles.Cast<ObjectId>(),
            _ => throw new ArgumentException("알 수 없는 스타일 종류입니다.")
        };
    }

    public static Entity ByHandle(Transaction transaction, Database database, string handle)
    {
        bool valid = long.TryParse(handle, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out long value);
        if (!valid || !database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased)
        {
            throw new ArgumentException($"객체 '{handle}'이 없습니다.");
        }

        return transaction.GetObject(id, OpenMode.ForRead) as Entity
            ?? throw new ArgumentException("도면 객체만 선택할 수 있습니다.");
    }
}
