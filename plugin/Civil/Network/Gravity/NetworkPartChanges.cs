using System.Text.Json;
using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class NetworkPartChanges
{
    public static string Validate(Database database, Transaction transaction, JsonObject request, List<string> details)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        string kind = operation.Split('.')[0];
        bool create = operation.EndsWith(".create", StringComparison.Ordinal);
        Part? part = create ? null : Find(database, transaction, request, kind);
        Network network = create
            ? CivilObjectAccess.Find<Network>(transaction, database, CivilObjectAccess.Text(request, "network"))
            : (Network)transaction.GetObject(part!.NetworkId, OpenMode.ForRead);
        NetworkPartAccess.ValidateNetwork(database, transaction, network, request, details);
        if (part is not null)
        {
            details.Add($"대상: {part.Name} [{part.Handle}], {part.PartFamilyName} / {part.PartSizeName}");
        }

        ValidateProperties(database, transaction, network, part, request, kind, create, details);
        bool hasFamily = request["family"] is not null;
        bool hasSize = request["size"] is not null;
        if ((create && !hasFamily) || hasFamily != hasSize)
        {
            throw new ArgumentException("생성·규격 교체에는 부품군 family와 정확한 규격 size를 함께 지정하세요.");
        }

        if (hasFamily)
        {
            NetworkCatalog.Selection selection = NetworkCatalog.Select(database, transaction, network, request, kind);
            details.Add($"부품군: {selection.Family.Name}, 규격: {selection.Size.Name} (근사 규격 선택 없음)");
        }

        if (kind == "pipe")
        {
            NetworkPipeChanges.Validate(database, transaction, network, part as Pipe, request, details);
        }
        else
        {
            ValidateStructure(part as Structure, request, create, details);
        }

        return $"{(kind == "pipe" ? "관" : "구조물")} {(create ? request["name"] : part!.Name)} {(create ? "생성" : "수정")}";
    }

    private static Part Find(Database database, Transaction transaction, JsonObject request, string kind)
    {
        string handle = CivilObjectAccess.Text(request, "handle");
        Part part = kind == "pipe" ? NetworkPartAccess.Find<Pipe>(database, transaction, handle)
            : NetworkPartAccess.Find<Structure>(database, transaction, handle);
        request["handle"] = part.Handle.ToString();
        request["targetState"] = JsonSerializer.SerializeToNode(NetworkPartAccess.Info(part));
        return part;
    }

    private static void ValidateProperties(Database database, Transaction transaction, Network network, Part? part,
        JsonObject request, string kind, bool create, List<string> details)
    {
        string key = create ? "name" : "newName";
        if (create || request[key] is not null)
        {
            string name = CivilObjectAccess.Text(request, key);
            NetworkPartAccess.Name(transaction, network, part, name);
            details.Add($"이름: {part?.Name ?? "(새 부품)"} → {name}");
        }

        bool hasChanges = new[] { "newName", "description", "style", "layer", "family", "start", "end", "startStructure",
            "endStructure", "disconnectStart", "disconnectEnd", "position", "rotationDegrees", "rimElevation", "sumpElevation" }
            .Any(item => request[item] is not null && (!item.StartsWith("disconnect") || request[item]!.GetValue<bool>()));
        if (!create && !hasChanges)
        {
            throw new ArgumentException("변경할 부품 속성이나 형상을 지정하세요.");
        }

        if (request["description"] is not null)
        {
            string description = CivilObjectAccess.Text(request, "description");
            if (description.Length > 1000)
            {
                throw new ArgumentException("설명은 1000자 이하로 주세요.");
            }

            details.Add($"설명: {part?.Description} → {description}");
        }

        ValidateStyleAndLayer(database, transaction, network, request, kind, create, details);
    }

    private static void ValidateStyleAndLayer(Database database, Transaction transaction, Network network,
        JsonObject request, string kind, bool create, List<string> details)
    {
        if (request["style"] is not null)
        {
            ObjectId style = CivilObjectAccess.Style(transaction, database, kind, request["style"]!.ToString());
            details.Add($"스타일: {request["style"]}");
            request["style"] = style.Handle.ToString();
        }

        if (create)
        {
            ObjectId layer = kind == "pipe" ? network.PipePlanLayerId : network.StructurePlanLayerId;
            CivilObjectAccess.WritableLayer(transaction, layer);
            if (request["layer"] is null)
            {
                request["layer"] = ((LayerTableRecord)transaction.GetObject(layer, OpenMode.ForRead)).Name;
            }
        }

        if (request["layer"] is not null)
        {
            PrimitiveAccess.Layer(database, transaction, request);
            details.Add($"부품 레이어: {request["layer"]}");
        }
    }

    private static void ValidateStructure(Structure? structure, JsonObject request, bool create, List<string> details)
    {
        if (create || request["position"] is not null)
        {
            Point3d position = PrimitiveAccess.Point(request["position"]);
            details.Add($"구조물 삽입 위치: {PrimitiveAccess.PointText(position)}");
            if (request["rimElevation"] is not null
                && Math.Abs(position.Z - CivilObjectAccess.Number(request["rimElevation"])) > 1e-6)
            {
                throw new ArgumentException("삽입 위치 Z와 명시한 상단 표고를 같게 지정하세요.");
            }
        }

        if (request["rotationDegrees"] is not null)
        {
            details.Add($"구조물 회전: {CivilObjectAccess.Number(request["rotationDegrees"])}°");
        }

        if (request["rimElevation"] is not null)
        {
            details.Add($"상단 표고: {CivilObjectAccess.Number(request["rimElevation"])}. 지표면 자동 상단 조정을 끕니다.");
        }

        if (request["sumpElevation"] is not null)
        {
            details.Add($"바닥 표고: {CivilObjectAccess.Number(request["sumpElevation"])}. 바닥 제어를 표고 방식으로 설정합니다.");
        }

        double? rim = request["rimElevation"] is null ? structure?.RimElevation : CivilObjectAccess.Number(request["rimElevation"]);
        double? sump = request["sumpElevation"] is null ? structure?.SumpElevation : CivilObjectAccess.Number(request["sumpElevation"]);
        bool explicitElevations = request["rimElevation"] is not null || request["sumpElevation"] is not null;
        if (explicitElevations && rim.HasValue && sump.HasValue && sump.Value >= rim.Value)
        {
            throw new ArgumentException("구조물 바닥 표고는 상단 표고보다 낮아야 합니다.");
        }
    }

    public static object Apply(Database database, Transaction transaction, JsonObject request)
    {
        string operation = CivilObjectAccess.Text(request, "operation");
        string kind = operation.Split('.')[0];
        bool create = operation.EndsWith(".create", StringComparison.Ordinal);
        Network network = CivilObjectAccess.Find<Network>(transaction, database, CivilObjectAccess.Text(request, "network"));
        network = (Network)transaction.GetObject(network.ObjectId, OpenMode.ForWrite);
        Part part = create ? Create(transaction, database, network, request, kind)
            : Find(database, transaction, request, kind);
        part = (Part)transaction.GetObject(part.ObjectId, OpenMode.ForWrite);
        if (!create && request["family"] is not null)
        {
            NetworkCatalog.Selection selection = NetworkCatalog.Select(database, transaction, network, request, kind);
            Point3d beforeStart = part is Pipe oldPipe ? oldPipe.StartPoint : Point3d.Origin;
            Point3d beforeEnd = part is Pipe oldEndPipe ? oldEndPipe.EndPoint : Point3d.Origin;
            if (part is Pipe resized)
            {
                resized.HoldOnResizeType = HoldOnResizeType.Centerline;
            }

            part.SwapPartFamilyAndSize(selection.Family.ObjectId, selection.Size.ObjectId);
            bool changedCenterline = part is Pipe changed && (changed.StartPoint.DistanceTo(beforeStart) > 1e-6
                || changed.EndPoint.DistanceTo(beforeEnd) > 1e-6);
            if (changedCenterline)
            {
                throw new InvalidOperationException("규격 교체가 관 중심선 위치를 바꿔 전체 작업을 취소했습니다.");
            }
        }

        if (part is Pipe pipe)
        {
            NetworkPipeChanges.Apply(database, transaction, pipe, request);
        }
        else
        {
            ApplyStructure((Structure)part, request);
        }

        if (create)
        {
            part.Name = CivilObjectAccess.Text(request, "name");
        }

        CivilPropertyChanges.Apply(database, transaction, request, part, kind);
        return new { part = NetworkPartAccess.Info(part) };
    }

    private static Part Create(Transaction transaction, Database database, Network network, JsonObject request, string kind)
    {
        NetworkCatalog.Selection selection = NetworkCatalog.Select(database, transaction, network, request, kind);
        ObjectId id = ObjectId.Null;
        if (kind == "pipe")
        {
            if (request["curveBulge"] is not null)
            {
                using PipeCurveGeometry curve = new(PrimitiveAccess.Point(request["start"]), PrimitiveAccess.Point(request["end"]), CivilObjectAccess.Number(request["curveBulge"]));
                id = network.AddCurvePipe(selection.Family.ObjectId, selection.Size.ObjectId, curve, false);
            }
            else
            {
                using LineSegment3d line = new(PrimitiveAccess.Point(request["start"]), PrimitiveAccess.Point(request["end"]));
                network.AddLinePipe(selection.Family.ObjectId, selection.Size.ObjectId, line, ref id, false);
            }
        }
        else
        {
            double rotation = request["rotationDegrees"] is null ? 0 : CivilObjectAccess.Number(request["rotationDegrees"]);
            network.AddStructure(selection.Family.ObjectId, selection.Size.ObjectId, PrimitiveAccess.Point(request["position"]),
                rotation * Math.PI / 180, ref id, false);
        }

        return (Part)transaction.GetObject(id, OpenMode.ForWrite);
    }

    private static void ApplyStructure(Structure structure, JsonObject request)
    {
        if (request["position"] is not null)
        {
            structure.Location = PrimitiveAccess.Point(request["position"]);
        }

        if (request["rotationDegrees"] is not null)
        {
            structure.Rotation = CivilObjectAccess.Number(request["rotationDegrees"]) * Math.PI / 180;
        }

        if (request["rimElevation"] is not null)
        {
            structure.AutomaticRimSurfaceAdjustment = false;
            structure.RimElevation = CivilObjectAccess.Number(request["rimElevation"]);
        }

        if (request["sumpElevation"] is not null)
        {
            structure.ControlSumpBy = StructureControlSumpType.ByElevation;
            structure.SumpElevation = CivilObjectAccess.Number(request["sumpElevation"]);
        }

        bool explicitElevations = request["rimElevation"] is not null || request["sumpElevation"] is not null;
        if (explicitElevations && structure.SumpElevation >= structure.RimElevation)
        {
            throw new InvalidOperationException("생성·수정된 구조물의 상단/바닥 표고가 유효하지 않아 취소했습니다.");
        }

        if (request["position"] is not null
            && structure.Location.DistanceTo(PrimitiveAccess.Point(request["position"])) > 1e-6)
        {
            throw new InvalidOperationException("Civil 3D가 요청한 구조물 삽입 위치를 유지하지 않아 취소했습니다.");
        }

        if (request["rotationDegrees"] is not null)
        {
            double target = CivilObjectAccess.Number(request["rotationDegrees"]) * Math.PI / 180;
            if (Math.Abs(Math.IEEERemainder(structure.Rotation - target, Math.PI * 2)) > 1e-6)
            {
                throw new InvalidOperationException("Civil 3D가 요청한 구조물 회전을 유지하지 않아 취소했습니다.");
            }
        }

        foreach (var (key, value) in new[] { ("rimElevation", structure.RimElevation), ("sumpElevation", structure.SumpElevation) })
        {
            if (request[key] is not null && Math.Abs(CivilObjectAccess.Number(request[key]) - value) > 1e-6)
            {
                throw new InvalidOperationException("Civil 3D가 요청한 구조물 표고를 유지하지 않아 취소했습니다.");
            }
        }
    }
}
