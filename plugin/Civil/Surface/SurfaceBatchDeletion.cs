using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Surface = Autodesk.Civil.DatabaseServices.Surface;

namespace MyCivil3DMcp.Plugin;

internal static class SurfaceBatchDeletion
{
    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        bool names = request["surfaces"] is JsonArray;
        bool matching = request["nameContains"] is not null;
        if (names == matching)
        {
            throw new ArgumentException("지표면 목록 또는 이름 포함 조건 중 하나를 지정하세요.");
        }

        string[] keys;
        if (matching)
        {
            string part = CivilObjectAccess.Text(request, "nameContains").Trim();
            if (part.Length == 0)
            {
                throw new ArgumentException("빈 이름 조건으로 모든 지표면을 지울 수 없습니다.");
            }

            keys = CivilObjectAccess.All<Surface>(transaction, database)
                .Where(surface => surface.Name.Contains(part, StringComparison.OrdinalIgnoreCase))
                .Select(surface => surface.Handle.ToString()).ToArray();
        }
        else
        {
            keys = ((JsonArray)request["surfaces"]!).Select(node => node!.GetValue<string>()).ToArray();
        }

        string[] handles = keys.Select(key => CivilObjectAccess.Find<Surface>(transaction, database, key))
            .DistinctBy(surface => surface.ObjectId).Select(surface => surface.Handle.ToString()).ToArray();
        if (handles.Length is < 1 or > 100)
        {
            throw new ArgumentException("삭제할 지표면은 1~100개여야 합니다.");
        }

        foreach (string handle in handles)
        {
            JsonObject single = new() { ["operation"] = "surface.delete", ["surface"] = handle };
            SurfaceChanges.Validate(database, transaction, single, details);
        }

        request.Remove("nameContains");
        request["surfaces"] = new JsonArray(handles.Select(handle => JsonValue.Create(handle)).ToArray());
        details.Add("연결 객체가 있는 지표면이 하나라도 있으면 전체 작업을 거절합니다. 임의로 설계 연결을 제거하지 않습니다.");
        return $"지표면 {handles.Length}개 삭제";
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        string[] handles = ((JsonArray)request["surfaces"]!).Select(node => node!.GetValue<string>()).ToArray();
        foreach (string handle in handles)
        {
            Surface surface = CivilObjectAccess.Find<Surface>(transaction, database, handle);
            Surface writable = (Surface)transaction.GetObject(surface.ObjectId, OpenMode.ForWrite);
            writable.Erase();
        }

        return new { deleted = handles };
    }
}
