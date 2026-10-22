using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

// 질문 준비에 필요한 정보만 같은 도면 잠금 안에서 읽는다. 전체 형상·객체 수는 읽지 않는다.
public static class DrawingChatContext
{
    public static object Read(Document document)
    {
        object selection = ReadOptional("selection", () => DrawingSelection.Get(document),
            new { totalCount = 0, items = Array.Empty<object>() }, out string? selectionError);
        object alignments = ReadOptional("alignments", () => ReadAlignments(document),
            new { totalCount = 0, items = Array.Empty<object>() }, out string? outlineError);

        return new
        {
            status = new
            {
                drawingName = document.Name,
                filePath = document.Database.Filename ?? string.Empty,
                drawingId = DrawingRevisions.Id(document.Database),
                revision = DrawingRevisions.Of(document.Database)
            },
            selection,
            selectionError,
            alignments,
            outlineError
        };
    }

    private static object ReadOptional(string name, Func<object> query, object fallback, out string? error)
    {
        try
        {
            error = null;
            return query();
        }
        catch (System.Exception ex)
        {
            error = ex.Message;
            NodeService.LogBridgeError("drawing.chat_context." + name, ex);
            return fallback;
        }
    }

    private static object ReadAlignments(Document document)
    {
        using Transaction transaction = document.Database.TransactionManager.StartTransaction();
        List<Alignment> alignments = AlignmentQueries.AllAlignments(transaction)
            .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        object[] items = alignments.Take(15).Select(alignment => ReadAlignment(transaction, alignment)).ToArray();
        return new { totalCount = alignments.Count, items };
    }

    private static object ReadAlignment(Transaction transaction, Alignment alignment)
    {
        AlignmentSummary summary = AlignmentQueries.Summarize(transaction, alignment);
        object[] profiles = alignment.GetProfileIds().Cast<ObjectId>()
            .Select(id => (Profile)transaction.GetObject(id, OpenMode.ForRead))
            .Select(profile => (object)new { name = profile.Name, type = profile.ProfileType.ToString() })
            .ToArray();

        return new { summary.Name, summary.Handle, summary.Type, summary.StartStationText,
            summary.EndStationText, summary.ProfileCount, summary.Description, profiles };
    }
}
