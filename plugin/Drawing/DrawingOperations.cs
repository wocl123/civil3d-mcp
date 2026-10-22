using System.Text.Json;
using System.Text.Json.Nodes;
using System.Security.Cryptography;
using System.Text;
using Autodesk.AutoCAD.ApplicationServices;

namespace MyCivil3DMcp.Plugin;

// 커밋 결과는 세션 안에 보관한다. 응답 유실 후 같은 작업을 재실행하지 않고 조회할 수 있다.
// 되돌리기는 그 작업이 현재 도면의 마지막 편집인 경우에만 허용한다.
//
// 작업 하나의 기록은 두 부분이다.
//   Journal: 작업 시작~끝(UNDO 그룹)에 바뀐 도면 객체. 되돌리기가 "이 작업"의 UNDO 단계를 알아보는 기준.
//   After:   작업이 끝난 때부터 되돌리기를 누를 때까지 도면에 일어난 일(객체 변경, 실행한 명령).
//            되돌리기는 이 기록만큼 거슬러 올라가 작업 시작 시점으로 돌아간다.
internal static class DrawingOperations
{
    private sealed class Receipt(string drawingId, string digest)
    {
        public string DrawingId = drawingId;
        public string Digest = digest;
        public string State = "running";
        public string Revision = "";
        public object? Result;

        // 작업 기록: UNDO 그룹 시작~끝 사이에 바뀐 도면 객체(핸들 → 결과: 추가·수정·삭제).
        public Dictionary<string, string> Journal = new();

        // 작업 뒤 기록: 되돌리기·재적용·도면 닫기 전까지 켜 둔다.
        public DrawingRevisions.Recorder? After;
        public List<string> CommandsAfter = new();
        public IntPtr Database;

        public void StopAfter()
        {
            After?.Dispose();
            After = null;
        }
    }

    private const int MaxReceipts = 1000;
    private const int MaxCommandsAfter = 200;

    // UNDO 기록의 처음까지 가도 작업을 찾지 못할 때 멈추는 안전장치. 정상일 때는 작업 기록으로 멈춘다.
    private const int UndoHistoryGuard = 200;

    private static readonly Dictionary<string, Receipt> Receipts = new();
    private static readonly HashSet<IntPtr> WatchedDocuments = new();
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    // 우리가 실행하는 UNDO 명령은 "작업 뒤 사용자가 실행한 명령"으로 세지 않는다.
    private static bool _ownCommand;

    public static string OperationId(JsonObject? parameters)
    {
        string? id = parameters?["operationId"]?.ToString();
        if (!Guid.TryParse(id, out _))
        {
            throw new BridgeFailure("invalid_operation", "작업 ID가 올바르지 않습니다.");
        }

        return id!;
    }

    public static void Validate(Document doc, JsonObject? context, bool required = false)
    {
        if (context is null)
        {
            if (required)
            {
                throw new BridgeFailure("old_plugin", "도면 식별 정보가 없는 변경 요청입니다. 다시 검토하세요.");
            }

            return;
        }

        if (context["drawingId"]?.ToString() != DrawingRevisions.Id(doc.Database))
        {
            throw new BridgeFailure("drawing_mismatch", "수정안을 계산한 도면과 현재 도면이 다릅니다.");
        }

        if (context["revision"]?.ToString() != DrawingRevisions.Of(doc.Database))
        {
            throw new BridgeFailure("revision_mismatch", "도면이 계획 뒤에 바뀌었습니다. 다시 검토하세요.");
        }
    }

    public static object Apply(Document doc, JsonObject? parameters, JsonObject? context, Func<object> edit)
    {
        string id = OperationId(parameters);
        string drawing = DrawingRevisions.Id(doc.Database);
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(parameters!.ToJsonString())));

        // 같은 작업 ID가 다시 오면(응답 유실 후 재시도) 실행하지 않고 기록을 돌려준다.
        if (Receipts.TryGetValue(id, out Receipt? existing))
        {
            return ExistingReceipt(id, existing, drawing, digest);
        }

        Validate(doc, context, required: true);

        if (Receipts.Count >= MaxReceipts)
        {
            throw new BridgeFailure("operation_limit", "이번 세션의 변경 기록 한도에 도달했습니다.");
        }

        Receipt receipt = new(drawing, digest);
        Receipts.Add(id, receipt);
        if (IsTransientDisplay(parameters))
        {
            return ApplyTransientDisplay(doc, id, receipt, edit);
        }

        bool committed = false;

        // 새 작업이 도면을 바꾸면 이 도면의 이전 작업들은 더 이상 마지막 편집이 아니다. 그 뒤 기록은 멈춘다.
        IEnumerable<Receipt> olderOnThisDrawing = Receipts.Values
            .Where(item => item.After is not null && item.Database == doc.Database.UnmanagedObject);
        foreach (Receipt older in olderOnThisDrawing)
        {
            older.StopAfter();
        }

        try
        {
            using (DrawingRevisions.Recorder journal = DrawingRevisions.Record(doc.Database))
            {
                _ownCommand = true;
                try
                {
                    doc.Editor.Command("_.UNDO", "_BEgin");
                    try
                    {
                        receipt.Result = edit();
                        committed = true;
                    }
                    finally
                    {
                        doc.Editor.Command("_.UNDO", "_End");
                    }
                }
                finally
                {
                    _ownCommand = false;
                }

                receipt.Journal = SummarizeJournal(journal.Changes);
            }

            receipt.State = "applied";
            receipt.Revision = DrawingRevisions.Of(doc.Database);

            // 이 시점부터 되돌리기를 누를 때까지 도면에 일어난 일을 기록한다.
            receipt.Database = doc.Database.UnmanagedObject;
            receipt.After = DrawingRevisions.Record(doc.Database);
            WatchCommands(doc);

            return View(id, receipt);
        }
        catch
        {
            receipt.State = committed ? "unknown" : "rejected";
            receipt.Revision = DrawingRevisions.Of(doc.Database);

            if (committed)
            {
                throw new BridgeFailure(
                    "post_commit", "변경 후 UNDO 그룹 종료에 실패했습니다. 적용 결과를 확인하세요.", "unknown");
            }

            throw;
        }
    }

    private static bool IsTransientDisplay(JsonObject? parameters)
    {
        JsonNode? request = parameters?["plan"]?["request"];
        bool display = request?["operation"]?.ToString() == "drawing.display";
        string? action = request?["action"]?.ToString();
        return (display && action is "select" or "selectLayer" or "viewer") || request?["operation"]?.ToString() == "native.assist";
    }

    // UNDO End 명령이 PickFirst 선택을 지우므로 선택·뷰어는 UNDO 그룹을 만들지 않는다.
    // 도면을 바꾸지 않아 이전 편집의 After 기록도 그대로 유지한다.
    private static object ApplyTransientDisplay(Document doc, string id, Receipt receipt, Func<object> edit)
    {
        try
        {
            receipt.Result = edit();
            receipt.State = "applied";
            receipt.Revision = DrawingRevisions.Of(doc.Database);
            return View(id, receipt);
        }
        catch
        {
            receipt.State = "rejected";
            receipt.Revision = DrawingRevisions.Of(doc.Database);
            throw;
        }
    }

    private static object ExistingReceipt(string id, Receipt existing, string drawing, string digest)
    {
        if (existing.State == "cancelled")
        {
            throw new BridgeFailure("cancelled", "실행 전에 취소한 작업입니다.");
        }

        if (existing.DrawingId != drawing || existing.Digest != digest)
        {
            throw new BridgeFailure("operation_mismatch", "같은 작업 ID에 다른 요청을 사용할 수 없습니다.");
        }

        if (existing.State != "applied")
        {
            throw new BridgeFailure("already_applied", "이미 실행되었거나 결과 확인이 필요한 작업입니다.", "unknown");
        }

        return View(id, existing);
    }

    // 객체마다 결과로 정리한다: 작업 중 만든 것은 "추가", 그 외 지운 채 끝난 것은 "삭제", 나머지는 "수정".
    // (선형을 지우기 전에 종단 뷰를 지우면 선형이 먼저 "수정"되므로 첫 이벤트만 보면 안 된다.)
    private static Dictionary<string, string> SummarizeJournal(IReadOnlyList<DrawingRevisions.Change> changes)
    {
        Dictionary<string, string> journal = new();

        IEnumerable<IGrouping<string, DrawingRevisions.Change>> byHandle = changes
            .Where(change => change.Counted && change.Handle.Length > 0)
            .GroupBy(change => change.Handle);

        foreach (IGrouping<string, DrawingRevisions.Change> events in byHandle)
        {
            bool added = events.Any(change => change.Event == "추가");
            string? lastErase = events.LastOrDefault(change => change.Event is "삭제" or "삭제 취소")?.Event;

            if (added)
            {
                journal[events.Key] = "추가";
            }
            else if (lastErase == "삭제")
            {
                journal[events.Key] = "삭제";
            }
            else
            {
                journal[events.Key] = "수정";
            }
        }

        return journal;
    }

    // AI 취소 후 아직 명령 컨텍스트에 도착하지 않은 변경도 작업 ID로 막는다.
    // 이미 커밋한 작업은 취소하지 않고 결과를 반환하여 팔레트에 되돌리기를 제공한다.
    public static object Cancel(Document doc, JsonObject? parameters)
    {
        string id = OperationId(parameters);
        string drawing = DrawingRevisions.Id(doc.Database);

        if (parameters?["drawingId"]?.ToString() != drawing)
        {
            throw new BridgeFailure("drawing_mismatch", "취소할 작업의 도면이 현재 도면과 다릅니다.", "unknown");
        }

        if (!Receipts.TryGetValue(id, out Receipt? receipt))
        {
            if (Receipts.Count >= MaxReceipts)
            {
                throw new BridgeFailure("operation_limit", "작업 기록 한도에 도달했습니다.", "unknown");
            }

            receipt = new(drawing, "")
            {
                State = "cancelled",
                Revision = DrawingRevisions.Of(doc.Database)
            };
            Receipts.Add(id, receipt);
        }

        if (receipt.DrawingId != drawing)
        {
            throw new BridgeFailure("drawing_mismatch", "취소할 작업의 도면이 다릅니다.", "unknown");
        }

        return View(id, receipt);
    }

    // 확정: 사용자가 결과를 받아들였다(팔레트의 [확정]). 되돌리기에만 쓰는 기록(작업 기록, 작업 뒤 기록, 결과)을 버린다.
    // 확정한 작업은 버튼으로 되돌릴 수 없다(Ctrl+Z는 AutoCAD 기능이라 그대로 된다).
    // 영수증이 없으면(Civil 3D를 다시 켠 경우 등) 버릴 기록도 없으므로 확정으로 본다.
    public static object Confirm(JsonObject? parameters)
    {
        string id = OperationId(parameters);

        if (!Receipts.TryGetValue(id, out Receipt? receipt))
        {
            return new JsonObject { ["operationId"] = id, ["state"] = "confirmed" };
        }

        if (receipt.State is not ("applied" or "confirmed"))
        {
            throw new BridgeFailure("confirm_conflict", "적용된 상태의 작업만 확정할 수 있습니다.");
        }

        receipt.State = "confirmed";
        receipt.StopAfter();
        receipt.Journal = new();
        receipt.CommandsAfter = new();
        receipt.Result = null;

        return View(id, receipt);
    }

    public static object Result(Document doc, JsonObject? parameters)
    {
        string id = OperationId(parameters);

        bool found = Receipts.TryGetValue(id, out Receipt? receipt);
        if (!found || receipt!.DrawingId != DrawingRevisions.Id(doc.Database))
        {
            throw new BridgeFailure("operation_missing", "이 도면에서 작업 결과를 확인할 수 없습니다.", "unknown");
        }

        return View(id, receipt);
    }

    public static object Undo(Document doc, JsonObject? parameters)
    {
        string id = OperationId(parameters);

        bool found = Receipts.TryGetValue(id, out Receipt? receipt);
        if (!found || receipt!.DrawingId != DrawingRevisions.Id(doc.Database))
        {
            throw new BridgeFailure("drawing_mismatch", "되돌릴 작업의 도면이 현재 도면과 다릅니다.");
        }

        if (receipt.State == "undone")
        {
            return View(id, receipt);
        }

        if (receipt.State == "confirmed")
        {
            throw new BridgeFailure("undo_conflict", "확정한 작업이라 되돌리기 기록이 없습니다.");
        }

        if (receipt.State != "applied")
        {
            throw new BridgeFailure("undo_conflict", "적용 상태가 아닌 작업은 되돌릴 수 없습니다.");
        }

        EnsureNothingChangedAfter(doc, receipt);

        if (receipt.Journal.Count == 0)
        {
            throw new BridgeFailure(
                "undo_unknown", "이 작업이 바꾼 객체 기록이 없어 자동 복구를 확인할 수 없습니다. 도면을 확인해 주세요.");
        }

        // 작업 뒤에도 도면 객체를 바꾸지 않는 단계(화면 확대·이동, Civil 3D의 후속 처리 등)가 UNDO 기록에 쌓일 수 있다.
        // 위에서 그 사이 객체 변경이 없음을 확인했으므로, 한 단계씩 되돌리다 처음으로 객체가 돌아오는 단계가 이 작업이다.
        //   - 도면 객체를 건드리지 않은 단계: 작업 뒤 단계로 세고 계속한다.
        //   - 작업 기록의 객체를 되돌린 단계: 이 작업이다. 멈추고 확인한다.
        //     Civil 3D는 이때 연관 객체(라벨, 종단 뷰 등)도 함께 갱신할 수 있어, 기록에 없던 객체는 실패가 아니라 알림으로 센다.
        //   - 작업 기록의 객체를 하나도 되돌리지 않고 다른 객체만 바꾼 단계: 있으면 안 된다. 멈추고 알린다.
        string message = "되돌리기 결과를 확인하지 못했습니다. 도면을 확인해 주세요.";
        _ownCommand = true;
        try
        {
            List<string> skipped = new();
            int linked;

            while (true)
            {
                if (skipped.Count >= UndoHistoryGuard)
                {
                    throw new InvalidOperationException("UNDO 기록에서 이 작업을 찾지 못했습니다.");
                }

                IReadOnlyList<DrawingRevisions.Change> undone;
                using (DrawingRevisions.Recorder step = DrawingRevisions.Record(doc.Database))
                {
                    doc.Editor.Command("_.UNDO", "1");
                    undone = step.Changes;
                }

                List<DrawingRevisions.Change> objects = undone.Where(change => change.Counted).ToList();

                // 객체를 건드리지 않은 단계: 건너뛴다.
                if (objects.Count == 0)
                {
                    string label = undone.Count == 0
                        ? "변경 없음"
                        : string.Join("·", undone.Select(change => change.Type).Distinct());
                    skipped.Add(label);
                    continue;
                }

                // 작업 기록의 객체가 하나도 없는 단계: 다른 변경을 되돌렸다.
                if (!objects.Any(change => receipt.Journal.ContainsKey(change.Handle)))
                {
                    message = "이 작업이 아닌 다른 객체 변경이 되돌려졌을 수 있습니다. 도면을 확인해 주세요.";
                    throw new InvalidOperationException(message);
                }

                // 이 작업의 단계. 기록에 없던 객체(연관 객체)는 따로 센다.
                linked = objects
                    .Select(change => change.Handle)
                    .Where(handle => !receipt.Journal.ContainsKey(handle))
                    .Distinct()
                    .Count();
                break;
            }

            // 확인: 작업에서 지운 객체는 되살아나고, 만든 객체는 사라져야 한다.
            int wrong = receipt.Journal.Count(entry => entry.Value switch
            {
                "삭제" => !Exists(doc.Database, entry.Key),
                "추가" => Exists(doc.Database, entry.Key),
                _ => false
            });

            if (wrong > 0)
            {
                message = $"되돌렸지만 객체 {wrong}개가 작업 전 상태로 돌아오지 않았습니다. 도면을 확인해 주세요.";
                throw new InvalidOperationException(message);
            }

            receipt.State = "undone";
            receipt.Revision = DrawingRevisions.Of(doc.Database);
            receipt.StopAfter();

            JsonObject view = (JsonObject)View(id, receipt);
            // 삭제 복원 수와 작업에서 확인한 전체 객체 수를 구별한다(수정 객체는 삭제 복원이 아니다).
            view["restored"] = receipt.Journal.Count(entry => entry.Value == "삭제");
            view["verifiedObjects"] = receipt.Journal.Count;
            view["linkedObjects"] = linked;
            view["skippedSteps"] = ToJsonArray(skipped);
            view["commandsAfter"] = ToJsonArray(receipt.CommandsAfter);
            return view;
        }
        catch
        {
            receipt.State = "unknown";
            receipt.Revision = DrawingRevisions.Of(doc.Database);
            receipt.StopAfter();
            throw new BridgeFailure("undo_unknown", message, "unknown");
        }
        finally
        {
            _ownCommand = false;
        }
    }

    // 작업 뒤 기록: 그 사이 도면 객체가 바뀌었으면 되돌리지 않는다(사용자의 편집까지 지우게 된다).
    // 리비전 검사도 함께 한다(기록이 꺼졌거나 넘친 경우의 안전장치).
    private static void EnsureNothingChangedAfter(Document doc, Receipt receipt)
    {
        IReadOnlyList<DrawingRevisions.Change> after = receipt.After?.Changes ?? [];
        List<DrawingRevisions.Change> editedAfter = after.Where(change => change.Counted).ToList();

        bool recordUnreliable = receipt.After is null || receipt.After.Overflowed;
        bool revisionMoved = receipt.Revision != DrawingRevisions.Of(doc.Database);

        if (editedAfter.Count == 0 && !recordUnreliable && !revisionMoved)
        {
            return;
        }

        string commands = "";
        if (receipt.CommandsAfter.Count > 0)
        {
            commands = $" (그 뒤 실행한 명령: {string.Join(", ", receipt.CommandsAfter.Distinct().Take(8))})";
        }

        string what = "적용 후 도면이 바뀌어";
        if (editedAfter.Count > 0)
        {
            int changedObjects = editedAfter.Select(change => change.Handle).Distinct().Count();
            what = $"적용 후 도면 객체 {changedObjects}개가 바뀌어{commands}";
        }

        throw new BridgeFailure("undo_conflict", $"{what} 이 작업만 되돌릴 수 없습니다. 도면에서 직접 확인해 주세요.");
    }

    // 작업 뒤 사용자가 실행한 명령(ZOOM, PAN, MOVE 등)을 그 도면의 열린 작업 기록에 남긴다.
    private static void WatchCommands(Document doc)
    {
        if (!WatchedDocuments.Add(doc.Database.UnmanagedObject))
        {
            return;
        }

        IntPtr database = doc.Database.UnmanagedObject;

        doc.CommandEnded += (_, e) =>
        {
            if (_ownCommand)
            {
                return;
            }

            IEnumerable<Receipt> open = Receipts.Values
                .Where(item => item.After is not null && item.Database == database);
            foreach (Receipt receipt in open)
            {
                if (receipt.CommandsAfter.Count < MaxCommandsAfter)
                {
                    receipt.CommandsAfter.Add(e.GlobalCommandName);
                }
            }
        };

        // 닫힌 도면의 기록은 더 쓸 수 없다.
        doc.BeginDocumentClose += (_, _) =>
        {
            foreach (Receipt receipt in Receipts.Values.Where(item => item.Database == database))
            {
                receipt.StopAfter();
            }

            WatchedDocuments.Remove(database);
        };
    }

    // 핸들의 객체가 도면에 있고 지워지지 않았는지.
    private static bool Exists(Autodesk.AutoCAD.DatabaseServices.Database database, string handle)
    {
        if (!long.TryParse(handle, System.Globalization.NumberStyles.HexNumber, null, out long value))
        {
            return false;
        }

        var objectHandle = new Autodesk.AutoCAD.DatabaseServices.Handle(value);
        // 치수 블록의 BlockBegin/BlockEnd는 소유 블록만 지워져 IsErased가 false로 남을 수 있다.
        return database.TryGetObjectId(objectHandle, out var id) && !id.IsNull && !id.IsEffectivelyErased;
    }

    private static JsonArray ToJsonArray(IEnumerable<string> items) =>
        new(items.Select(item => (JsonNode?)JsonValue.Create(item)).ToArray());

    private static object View(string id, Receipt receipt)
    {
        JsonObject result = receipt.Result is null
            ? new()
            : JsonSerializer.SerializeToNode(receipt.Result, JsonOptions)!.AsObject();

        result["operationId"] = id;
        result["drawingId"] = receipt.DrawingId;
        result["revision"] = receipt.Revision;
        result["state"] = receipt.State;
        result["undoAvailable"] = receipt.State == "applied" && receipt.Journal.Count > 0
            && result["undoAvailable"]?.GetValue<bool>() != false;
        return result;
    }
}
