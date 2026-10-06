using System.IO;
using System.Drawing.Imaging;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.GraphicsSystem;
using Bitmap = System.Drawing.Bitmap;
using GsView = Autodesk.AutoCAD.GraphicsSystem.View;
using Rectangle = System.Drawing.Rectangle;

namespace MyCivil3DMcp.Plugin;

/// <summary>
/// Renders Model Space to a PNG in an off-screen view, framed on the given objects (or the
/// whole drawing), so the AI can look at what it created. The user's view is not touched.
/// </summary>
internal static class DrawingCapture
{
    private const int MaxHandles = 50;
    private const double Margin = 0.08;

    public static DrawingImage Capture(Document document, IReadOnlyList<string> handles, int width, int height)
    {
        if (handles.Count > MaxHandles) throw new ArgumentException($"At most {MaxHandles} handles can be framed.");
        Database database = document.Database;
        using Transaction transaction = database.TransactionManager.StartTransaction();

        Extents3d? frame = null;
        List<string> framed = new();
        foreach (string handle in handles)
        {
            if (!long.TryParse(handle, System.Globalization.NumberStyles.HexNumber, null, out long value))
                throw new ArgumentException($"Invalid handle {handle}.");
            if (!database.TryGetObjectId(new Handle(value), out ObjectId id) || id.IsErased) continue;
            if (transaction.GetObject(id, OpenMode.ForRead) is not Entity entity) continue;
            Extents3d? extents = Bounds(entity);
            if (extents is null) continue;
            framed.Add(handle);
            if (frame is { } current) { current.AddExtents(extents.Value); frame = current; }
            else frame = extents;
        }
        if (handles.Count > 0 && frame is null) throw new ArgumentException("None of the objects to frame was found.");
        frame ??= new Extents3d(database.Extmin, database.Extmax);

        // Pad the frame and widen it to the image's aspect ratio.
        Point3d min = frame.Value.MinPoint, max = frame.Value.MaxPoint;
        double fieldWidth = Math.Max(max.X - min.X, 1) * (1 + 2 * Margin);
        double fieldHeight = Math.Max(max.Y - min.Y, 1) * (1 + 2 * Margin);
        double aspect = (double)width / height;
        if (fieldWidth / fieldHeight < aspect) fieldWidth = fieldHeight * aspect; else fieldHeight = fieldWidth / aspect;
        Point3d center = new((min.X + max.X) / 2, (min.Y + max.Y) / 2, 0);

        BlockTableRecord modelSpace = (BlockTableRecord)transaction.GetObject(
            SymbolUtilityServices.GetBlockModelSpaceId(database), OpenMode.ForRead);
        Manager manager = document.GraphicsManager;
        using KernelDescriptor descriptor = new();
        descriptor.addRequirement(KernelDescriptor.Drawing3D);
        GraphicsKernel kernel = Manager.AcquireGraphicsKernel(descriptor);
        try
        {
            using Device device = manager.CreateAutoCADOffScreenDevice(kernel);
            device.OnSize(new System.Drawing.Size(width, height));
            device.DeviceRenderType = RendererType.Default;
            device.BackgroundColor = System.Drawing.Color.Black;
            using Model model = manager.CreateAutoCADModel(kernel);
            using GsView view = new();
            device.Add(view);
            view.Add(modelSpace, model);
            view.SetView(center + Vector3d.ZAxis, center, Vector3d.YAxis, fieldWidth, fieldHeight);
            device.Update();
            using Bitmap bitmap = view.GetSnapshot(new Rectangle(0, 0, width, height));
            using MemoryStream png = new();
            bitmap.Save(png, ImageFormat.Png);
            view.EraseAll();
            device.EraseAll();
            return new DrawingImage(width, height, Convert.ToBase64String(png.ToArray()),
                [Math.Round(center.X - fieldWidth / 2, 3), Math.Round(center.Y - fieldHeight / 2, 3),
                 Math.Round(center.X + fieldWidth / 2, 3), Math.Round(center.Y + fieldHeight / 2, 3)], framed);
        }
        finally { Manager.ReleaseGraphicsKernel(kernel); }
    }

    private static Extents3d? Bounds(Entity entity)
    {
        try { return entity.GeometricExtents; }
        catch (Autodesk.AutoCAD.Runtime.Exception) { return null; }
    }
}
