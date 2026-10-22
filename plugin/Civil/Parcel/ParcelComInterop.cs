using System.IO;
using Assembly = System.Reflection.Assembly;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

// Civil COM interop is isolated from parcel validation and transaction management.
// This needs the real Civil GUI host; Core Console cannot initialize the provider.
internal static class ParcelComInterop
{
    public static void AddBoundary(Database database, Site site, Polyline source)
    {
        // Explicit Civil interfaces avoid AcadEntity's default dispatch and dynamic binder overflow.
        string folder = Path.GetDirectoryName(typeof(Site).Assembly.Location)!;
        Assembly interop = Assembly.LoadFrom(Path.Combine(folder, "Autodesk.AECC.Interop.Land.dll"));
        object provider = Activator.CreateInstance(Type.GetTypeFromProgID("AeccXLand.AeccDatabase.13.7", true)!)!;
        interop.GetType("Autodesk.AECC.Interop.Land.IAeccDatabase", true)!.GetMethod("Init")!
            .Invoke(provider, new object[] { database.AcadDatabase });

        Type siteType = interop.GetType("Autodesk.AECC.Interop.Land.IAeccSite", true)!;
        object segments = siteType.GetProperty("ParcelSegments")!.GetValue(site.AcadObject)
            ?? throw new ArgumentException("Civil COM 필지 경계 API를 사용할 수 없습니다.");
        interop.GetType("Autodesk.AECC.Interop.Land.IAeccParcelSegments", true)!.GetMethod("AddFromEntity")!
            .Invoke(segments, new object[] { source.AcadObject, false });
    }
}
