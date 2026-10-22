using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.ApplicationServices;

namespace MyCivil3DMcp.Plugin;

internal static class CivilCoordinates
{
    internal sealed record Context(string CivilUnits, string InsertionUnits, string? CoordinateSystem);

    internal static Context Read(Database database)
    {
        var zone = CivilDocument.GetCivilDocument(database).Settings.DrawingSettings.UnitZoneSettings;
        return new Context(zone.DrawingUnits.ToString(), database.Insunits.ToString(), zone.CoordinateSystemCode);
    }

    internal static string Notice(Context context)
    {
        string units = context.CivilUnits switch { "Meters" => "미터", "Feet" => "피트", _ => context.CivilUnits };
        string system = string.IsNullOrEmpty(context.CoordinateSystem) ? "미지정" : context.CoordinateSystem;
        return $"WCS 좌표 · Civil 설정 단위: {units} · 도면 삽입 단위: {context.InsertionUnits} · 좌표계: {system}. 자동 단위·좌표 변환은 하지 않습니다.";
    }
}
