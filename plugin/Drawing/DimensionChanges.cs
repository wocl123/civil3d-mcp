using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

internal static class DimensionChanges
{
    public static object List(Document document, int offset, int limit)
    {
        DrawingQueries.ValidatePage(offset, limit);
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Dimension[] items = PrimitiveAccess.Entities(document.Database, transaction, true).OfType<Dimension>().ToArray();
        return new { totalCount = items.Length, offset, byKind = PrimitiveAccess.CountBy(items, Kind),
            items = items.Skip(offset).Take(limit).Select(Info).ToArray(),
            note = "measurement는 각도 치수만 도(°), 나머지는 도면 단위. text는 화면에 보이는 문자다." };
    }

    // 목록·계획에 같은 모양으로 보여 준다. 값은 소수 셋째 자리까지.
    private static object Info(Dimension dimension) => new
    {
        handle = dimension.Handle.ToString(), kind = Kind(dimension), dimension.Layer,
        measurement = Math.Round(Measurement(dimension), 3), text = Shown(dimension),
        overridden = dimension.DimensionText.Length > 0, style = dimension.DimensionStyleName,
        textPosition = PrimitiveAccess.DisplayPoint(dimension.TextPosition)
    };

    private static string Line(Dimension dimension) =>
        $"{Kind(dimension)} 치수 [{dimension.Handle}] · 레이어 {dimension.Layer} · 값 {Value(dimension)} · 문자 {Shown(dimension)}";

    private static string Kind(Dimension dimension) => dimension switch
    {
        RotatedDimension => "회전",
        AlignedDimension => "정렬",
        RadialDimensionLarge => "꺾인 반지름",
        RadialDimension => "반지름",
        DiametricDimension => "지름",
        Point3AngularDimension or LineAngularDimension2 => "각도",
        OrdinateDimension => "세로좌표",
        ArcDimension => "호 길이",
        _ => dimension.GetType().Name
    };

    private static bool Angular(Dimension dimension) => dimension is Point3AngularDimension or LineAngularDimension2;

    private static double Measurement(Dimension dimension) =>
        Angular(dimension) ? dimension.Measurement * 180 / Math.PI : dimension.Measurement;

    private static string Value(Dimension dimension) =>
        PrimitiveAccess.Number(Measurement(dimension)) + (Angular(dimension) ? "°" : "");

    // 문자 재정의가 없으면 측정값, "<>"가 있으면 그 자리에 측정값이 들어간다.
    private static string Shown(Dimension dimension)
    {
        string text = dimension.DimensionText;
        return text.Length == 0 ? Value(dimension) : text.Replace("<>", Value(dimension));
    }

    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "dimension.create")
        {
            PrimitiveAccess.Layer(database, transaction, request);
            ObjectId style = Style(database, transaction, request);
            using Dimension dimension = Create(request, style);
            details.Add($"{Kind(dimension)} 치수 · 레이어 {request["layer"]} · 스타일 {request["style"]}");
            details.Add("정의점(WCS): " + string.Join(" · ", new[] { "start", "end", "center", "location" }
                .Where(key => request[key] is not null)
                .Select(key => $"{key} {PrimitiveAccess.PointText(PrimitiveAccess.Point(request[key]))}")));
            if (request["text"] is not null)
            {
                details.Add($"문자 재정의: {request["text"]}");
            }

            details.Add("객체에 연관되지 않은 독립 치수입니다.");
            return "치수선 1개 생성";
        }

        Entity[] targets = PrimitiveAccess.Targets<Dimension>(database, transaction, request);
        Dimension[] dimensions = targets.Cast<Dimension>().ToArray();
        if (operation == "dimension.edit")
        {
            ValidateEdit(database, transaction, request, dimensions);
            details.Add("바꿀 속성: " + string.Join(" · ", EditFields(request)));
        }
        else
        {
            details.Add("종류별: " + string.Join(" · ", PrimitiveAccess.CountBy(dimensions, Kind)
                .Select(pair => $"{pair.Key} {pair.Value}개")));
        }

        PrimitiveAccess.AddItems(details, dimensions.Select(Line).ToArray());
        details.Add(operation == "dimension.delete" ? "일반 치수 객체만 삭제합니다. Civil 라벨·지시선은 대상이 아닙니다."
            : "지정한 속성만 변경하며 측정값을 임의의 값으로 덮어쓰지 않습니다.");
        return $"치수선 {targets.Length}개 " + (operation == "dimension.delete" ? "삭제" : "수정");
    }

    private static ObjectId Style(Database database, Transaction transaction, JsonObject request)
    {
        DimStyleTable table = (DimStyleTable)transaction.GetObject(database.DimStyleTableId, OpenMode.ForRead);
        ObjectId id = database.Dimstyle;
        if (request["style"] is not null)
        {
            string name = CivilObjectAccess.Text(request, "style");
            if (!table.Has(name))
            {
                string names = string.Join(", ", table.Cast<ObjectId>().Select(styleId =>
                    ((DimStyleTableRecord)transaction.GetObject(styleId, OpenMode.ForRead)).Name));
                throw new ArgumentException($"치수 스타일 '{name}'이 없습니다. 사용 가능: {names}");
            }

            id = table[name];
        }

        DimStyleTableRecord style = (DimStyleTableRecord)transaction.GetObject(id, OpenMode.ForRead);
        if (style.IsDependent)
        {
            throw new ArgumentException("외부참조의 치수 스타일은 사용할 수 없습니다.");
        }

        request["style"] = style.Name;
        return id;
    }

    private static Dimension Create(JsonObject request, ObjectId style)
    {
        string kind = CivilObjectAccess.Text(request, "kind");
        Point3d start = PrimitiveAccess.Point(request["start"]);
        Point3d location = PrimitiveAccess.Point(request["location"]);
        string text = request["text"]?.GetValue<string>() ?? "";
        Point3d end = request["end"] is null ? start : PrimitiveAccess.Point(request["end"]);
        bool planar = Math.Abs(start.Z - location.Z) < 1e-9 && Math.Abs(end.Z - start.Z) < 1e-9;
        if (!planar || text.Length > 1000)
        {
            throw new ArgumentException("치수 정의점은 같은 WCS XY 평면에 두고, 문자는 1000자 이하로 주세요.");
        }

        if (kind is "aligned" or "rotated" or "diametric" && start.DistanceTo(end) <= 1e-9)
        {
            throw new ArgumentException("치수의 두 정의점이 겹칩니다.");
        }

        double leader = request["leaderLength"] is null ? 0 : CivilObjectAccess.Number(request["leaderLength"]);
        if (kind == "radial" && start.DistanceTo(location) <= 1e-9)
        {
            throw new ArgumentException("반지름 치수의 중심과 원 위 점이 겹칩니다.");
        }

        if (leader < 0)
        {
            throw new ArgumentException("지시선 길이는 음수일 수 없습니다.");
        }

        return kind switch
        {
            "aligned" => new AlignedDimension(start, end, location, text, style),
            "rotated" => new RotatedDimension(Rotation(request), start, end, location, text, style),
            "radial" => new RadialDimension(start, location, leader, text, style),
            "diametric" => new DiametricDimension(start, end, leader, text, style) { TextPosition = location },
            "angular" => Angular(request, start, end, location, text, style),
            "ordinate" => new OrdinateDimension(request["usingXAxis"]?.GetValue<bool>() ?? true,
                start, location, text, style),
            _ => throw new ArgumentException("지원하는 치수 종류: aligned, rotated, radial, diametric, angular, ordinate")
        };
    }

    private static double Rotation(JsonObject request) =>
        CivilObjectAccess.Number(request["rotationDegrees"]) * Math.PI / 180;

    private static Dimension Angular(JsonObject request, Point3d start, Point3d end, Point3d location,
        string text, ObjectId style)
    {
        Point3d center = PrimitiveAccess.Point(request["center"]);
        Vector3d first = start - center;
        Vector3d second = end - center;
        bool invalid = Math.Abs(center.Z - start.Z) > 1e-9 || first.Length <= 1e-9 || second.Length <= 1e-9
            || first.CrossProduct(second).Length <= 1e-9;
        if (invalid)
        {
            throw new ArgumentException("각도 치수는 같은 평면에서 중심과 서로 다른 두 방향을 지정하세요.");
        }

        return new Point3AngularDimension(center, start, end, location, text, style);
    }

    private static IEnumerable<string> EditFields(JsonObject request)
    {
        if (request["text"] is not null)
        {
            string text = CivilObjectAccess.Text(request, "text");
            yield return text.Length == 0 ? "문자 → 측정값으로 복원" : $"문자 → {text}";
        }

        if (request["textPosition"] is not null)
        {
            yield return "문자 위치 → " + PrimitiveAccess.PointText(PrimitiveAccess.Point(request["textPosition"]));
        }

        if (request["style"] is not null)
        {
            yield return $"스타일 → {request["style"]}";
        }

        if (request["layer"] is not null)
        {
            yield return $"레이어 → {request["layer"]}";
        }

        if (request["rotationDegrees"] is not null)
        {
            yield return $"회전각 → {PrimitiveAccess.Number(CivilObjectAccess.Number(request["rotationDegrees"]))}°";
        }
    }

    private static void ValidateEdit(Database database, Transaction transaction, JsonObject request, Dimension[] targets)
    {
        string[] fields = ["text", "textPosition", "style", "layer", "rotationDegrees"];
        if (!fields.Any(field => request[field] is not null))
        {
            throw new ArgumentException("변경할 치수 속성을 지정하세요.");
        }

        if (request["text"] is not null && CivilObjectAccess.Text(request, "text").Length > 1000)
        {
            throw new ArgumentException("치수 문자는 1000자 이하로 주세요.");
        }

        if (request["style"] is not null)
        {
            Style(database, transaction, request);
        }

        if (request["layer"] is not null)
        {
            PrimitiveAccess.Layer(database, transaction, request);
        }

        if (request["textPosition"] is not null)
        {
            PrimitiveAccess.Point(request["textPosition"]);
        }

        if (request["rotationDegrees"] is not null)
        {
            Rotation(request);
            if (targets.Any(dimension => dimension is not RotatedDimension))
            {
                throw new ArgumentException("회전각 변경은 RotatedDimension에만 사용할 수 있습니다.");
            }
        }
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        if (operation == "dimension.delete")
        {
            return new { deleted = PrimitiveAccess.Erase(database, transaction, request) };
        }

        if (operation == "dimension.create")
        {
            using Dimension dimension = Create(request, Style(database, transaction, request));
            dimension.SetDatabaseDefaults(database);
            dimension.DimensionStyle = Style(database, transaction, request);
            dimension.LayerId = PrimitiveAccess.Layer(database, transaction, request);
            ObjectId id = PrimitiveAccess.Append(database, transaction, dimension);
            dimension.RecomputeDimensionBlock(true);
            return new { created = new[] { id.Handle.ToString() } };
        }

        string[] handles = ((JsonArray)request["handles"]!).Select(node => node!.GetValue<string>()).ToArray();
        foreach (string handle in handles)
        {
            Entity entity = CivilObjectAccess.ByHandle(transaction, database, handle);
            Dimension dimension = (Dimension)transaction.GetObject(entity.ObjectId, OpenMode.ForWrite);
            ApplyProperties(database, transaction, request, dimension);
            dimension.RecomputeDimensionBlock(true);
        }

        return new { modified = handles };
    }

    private static void ApplyProperties(Database database, Transaction transaction, JsonObject request, Dimension dimension)
    {
        if (request["style"] is not null)
        {
            dimension.DimensionStyle = Style(database, transaction, request);
        }

        if (request["layer"] is not null)
        {
            dimension.LayerId = PrimitiveAccess.Layer(database, transaction, request);
        }

        if (request["text"] is not null)
        {
            dimension.DimensionText = CivilObjectAccess.Text(request, "text");
        }

        if (request["textPosition"] is not null)
        {
            dimension.TextPosition = PrimitiveAccess.Point(request["textPosition"]);
        }

        if (request["rotationDegrees"] is not null)
        {
            ((RotatedDimension)dimension).Rotation = Rotation(request);
        }
    }
}
