using System.Text.Json.Nodes;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.Geometry;

namespace MyCivil3DMcp.Plugin;

// 화면 확대(줌)만 바꾼다. 도면 데이터는 바꾸지 않으므로 계획·동의 없이 실행하고 Undo 대상도 아니다.
internal static class DrawingView
{
    private const double Margin = 1.1;

    public static object Zoom(Document document, JsonObject? parameters)
    {
        Extents3d extents = Target(document, parameters);
        Editor editor = document.Editor;
        using ViewTableRecord view = editor.GetCurrentView();
        Matrix3d toEye = (Matrix3d.Rotation(-view.ViewTwist, view.ViewDirection, view.Target)
            * Matrix3d.Displacement(view.Target - Point3d.Origin) * Matrix3d.PlaneToWorld(view.ViewDirection)).Inverse();
        Point3d low = extents.MinPoint;
        Point3d high = extents.MaxPoint;
        Point3d[] corners = [.. from x in new[] { low.X, high.X } from y in new[] { low.Y, high.Y }
            from z in new[] { low.Z, high.Z } select new Point3d(x, y, z).TransformBy(toEye)];
        Extents3d eye = new(corners[0], corners[0]);
        foreach (Point3d corner in corners)
        {
            eye.AddPoint(corner);
        }

        double minimum = parameters?["size"] is null ? 10 : Size(parameters);
        double width = Math.Max(eye.MaxPoint.X - eye.MinPoint.X, minimum) * Margin;
        double height = Math.Max(eye.MaxPoint.Y - eye.MinPoint.Y, minimum) * Margin;
        double ratio = view.Width / view.Height;
        if (width > height * ratio)
        {
            height = width / ratio;
        }
        else
        {
            width = height * ratio;
        }

        view.CenterPoint = new Point2d((eye.MinPoint.X + eye.MaxPoint.X) / 2, (eye.MinPoint.Y + eye.MaxPoint.Y) / 2);
        view.Width = width;
        view.Height = height;
        editor.SetCurrentView(view);
        Point3d center = extents.MinPoint + (extents.MaxPoint - extents.MinPoint) / 2;
        return new { zoomed = true, center = PrimitiveAccess.DisplayPoint(center),
            viewWidth = Math.Round(width, 3), viewHeight = Math.Round(height, 3),
            message = "화면 확대만 바꿨습니다. 도면 데이터는 바뀌지 않았습니다." };
    }

    private static double Size(JsonObject parameters)
    {
        double size = CivilObjectAccess.Number(parameters["size"]);
        if (size <= 0)
        {
            throw new ArgumentException("화면 크기 size는 0보다 커야 합니다.");
        }

        return size;
    }

    // 객체 핸들들의 범위, 또는 window(min/max), 또는 center 한 점.
    private static Extents3d Target(Document document, JsonObject? parameters)
    {
        string[] keys = ["handles", "window", "center"];
        if (keys.Count(key => parameters?[key] is not null) != 1)
        {
            throw new ArgumentException("객체 핸들, 창 범위(window) 또는 중심점(center) 중 하나를 지정하세요.");
        }

        if (parameters!["center"] is not null)
        {
            Point3d center = PrimitiveAccess.Point(parameters["center"]);
            return new Extents3d(center, center);
        }

        if (parameters["window"] is JsonObject window)
        {
            Point3d first = PrimitiveAccess.Point(window["min"]);
            Extents3d box = new(first, first);
            box.AddPoint(PrimitiveAccess.Point(window["max"]));
            return box;
        }

        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        Extents3d? extents = null;
        foreach (JsonNode? node in (JsonArray)parameters["handles"]!)
        {
            Entity entity = CivilObjectAccess.ByHandle(transaction, document.Database, node!.GetValue<string>());
            if (entity.OwnerId != document.Database.CurrentSpaceId)
            {
                throw new ArgumentException($"[{entity.Handle}]은(는) 현재 모형/배치 공간에 없어 확대할 수 없습니다.");
            }

            Extents3d bounds = Bounds(entity);
            if (extents is Extents3d current)
            {
                current.AddExtents(bounds);
                extents = current;
            }
            else
            {
                extents = bounds;
            }
        }

        return extents ?? throw new ArgumentException("확대할 객체가 없습니다.");
    }

    private static Extents3d Bounds(Entity entity)
    {
        try
        {
            return entity.GeometricExtents;
        }
        catch (Autodesk.AutoCAD.Runtime.Exception)
        {
            throw new ArgumentException($"[{entity.Handle}]은(는) 범위를 계산할 수 없는 객체입니다.");
        }
    }
}
