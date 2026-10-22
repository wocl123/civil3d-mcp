using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices.Styles;

namespace MyCivil3DMcp.Plugin;

internal static class CivilStyles
{
    public static object List(Document document, string kind, int offset, int limit)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        var styles = CivilObjectAccess.StyleIds(document.Database, kind)
            .Select(id => (StyleBase)transaction.GetObject(id, OpenMode.ForRead))
            .OrderBy(style => style.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        var items = styles.Skip(offset).Take(limit)
            .Select(style => new { name = style.Name, handle = style.Handle.ToString(),
                components = style is LabelStyle label ? label.GetComponents(LabelStyleComponentType.Text).Cast<ObjectId>()
                    .Select(i => (LabelStyleTextComponent)transaction.GetObject(i, OpenMode.ForRead))
                    .Select(c => new { handle = c.Handle.ToString(), name = c.General.Name, contents = c.Text.Contents.Value, height = c.Text.Height.Value }).ToArray() : null }).ToArray();
        return new { kind, total = styles.Length, offset, items,
            hasMore = offset + limit < styles.Length };
    }
}
