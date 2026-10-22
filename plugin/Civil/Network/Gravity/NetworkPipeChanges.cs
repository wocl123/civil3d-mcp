using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.Civil.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

internal static class NetworkPipeChanges
{
    public static void Validate(Database database, Transaction transaction, Network network, Pipe? pipe,
        JsonObject request, List<string> details)
    {
        bool hasGeometry = request["start"] is not null || request["end"] is not null;
        if (pipe is not null && hasGeometry && pipe.SubEntityType != PipeSubEntityType.Straight)
        {
            throw new ArgumentException("시작·끝 좌표 편집은 직선관에만 지원합니다. 곡선관 형상을 직선으로 바꾸지 않습니다.");
        }

        Point3d start = request["start"] is null && pipe is not null ? pipe.StartPoint : PrimitiveAccess.Point(request["start"]);
        Point3d end = request["end"] is null && pipe is not null ? pipe.EndPoint : PrimitiveAccess.Point(request["end"]);
        double length = new Point2d(start.X, start.Y).GetDistanceTo(new Point2d(end.X, end.Y));
        if (length <= 1e-6)
        {
            throw new ArgumentException("직선관 시작·끝의 XY 좌표가 서로 달라야 합니다.");
        }
        if (request["curveBulge"] is not null)
        {
            double bulge = CivilObjectAccess.Number(request["curveBulge"]);
            if (pipe is not null || Math.Abs(bulge) < 1e-8 || Math.Abs(bulge) > 1)
                throw new ArgumentException("곡선관 생성의 벌지는 0이 아니며 절댓값이 1 이하(180도 이하)여야 합니다. 기존 곡선 형상 변경은 별도 도구를 사용하세요.");
            double radius = length * (1 + bulge * bulge) / (4 * Math.Abs(bulge));
            length = radius * 4 * Math.Atan(Math.Abs(bulge));
            details.Add($"곡선관 벌지 {bulge}, 반지름 {radius}, 평면 호 길이 {length}");
        }

        if (pipe is null || hasGeometry)
        {
            details.Add($"관 중심선: {PrimitiveAccess.PointText(start)} → {PrimitiveAccess.PointText(end)}");
            details.Add($"수평 길이 {length}, 시작→끝 표고 기울기 {(end.Z - start.Z) / length}");
        }

        if (request["family"] is not null && pipe is not null)
        {
            details.Add("규격 교체 시 중심선 표고를 유지하고 관경에 따른 관저·관정 표고와 토피가 달라질 수 있습니다.");
        }

        JsonObject connections = new();
        connections["start"] = ValidateConnection(transaction, network, pipe, request, "start", start, details);
        connections["end"] = ValidateConnection(transaction, network, pipe, request, "end", end, details);
        request["expectedConnections"] = connections;
    }

    private static string? ValidateConnection(Transaction transaction, Network network, Pipe? pipe,
        JsonObject request, string side, Point3d position, List<string> details)
    {
        bool start = side == "start";
        string key = side + "Structure";
        string disconnectKey = start ? "disconnectStart" : "disconnectEnd";
        bool disconnect = request[disconnectKey]?.GetValue<bool>() == true;
        ObjectId before = pipe is null ? ObjectId.Null : start ? pipe.StartStructureId : pipe.EndStructureId;
        if (disconnect && (pipe is null || request[key] is not null))
        {
            throw new ArgumentException("연결 해제는 기존 관에만 지정하고 같은 끝의 구조물 연결과 함께 요청하지 마세요.");
        }

        ObjectId after = disconnect ? ObjectId.Null : before;
        if (request[key] is not null)
        {
            string text = CivilObjectAccess.Text(request, key);
            Structure structure = network.GetStructureIds().Cast<ObjectId>()
                .Select(id => (Structure)transaction.GetObject(id, OpenMode.ForRead))
                .SingleOrDefault(item => item.Handle.ToString().Equals(text, StringComparison.OrdinalIgnoreCase)
                    || item.Name.Equals(text, StringComparison.OrdinalIgnoreCase))
                ?? throw new ArgumentException("연결할 구조물은 같은 관망 안의 정확한 이름/핸들로 지정하세요.");
            bool replacing = !before.IsNull && before != structure.ObjectId;
            if (replacing && request["replaceConnections"]?.GetValue<bool>() != true)
            {
                throw new ArgumentException("기존 연결을 바꾸려면 replaceConnections=true를 명시하세요.");
            }

            after = structure.ObjectId;
            request[key] = structure.Handle.ToString();
            details.Add($"{(start ? "시작" : "끝")} 연결: {NetworkPartAccess.Handle(before) ?? "없음"} → {structure.Name} [{structure.Handle}]");
        }

        bool checkPosition = !after.IsNull && (pipe is null || request[side] is not null || request[key] is not null);
        if (checkPosition)
        {
            Structure structure = (Structure)transaction.GetObject(after, OpenMode.ForRead);
            double distance = new Point2d(position.X, position.Y)
                .GetDistanceTo(new Point2d(structure.Location.X, structure.Location.Y));
            if (distance > 1e-6)
            {
                throw new ArgumentException("연결할 관 끝과 구조물의 XY 좌표가 다릅니다. 구조물 위치에 맞추거나 먼저 연결 해제를 명시하세요.");
            }
        }

        if (disconnect)
        {
            details.Add($"{(start ? "시작" : "끝")} 구조물 연결 해제: {NetworkPartAccess.Handle(before) ?? "기존 연결 없음"}");
        }

        return NetworkPartAccess.Handle(after);
    }

    public static void Apply(Database database, Transaction transaction, Pipe pipe, JsonObject request)
    {
        if (request["disconnectStart"]?.GetValue<bool>() == true && !pipe.StartStructureId.IsNull)
        {
            pipe.Disconnect(ConnectorPositionType.Start);
        }

        if (request["disconnectEnd"]?.GetValue<bool>() == true && !pipe.EndStructureId.IsNull)
        {
            pipe.Disconnect(ConnectorPositionType.End);
        }

        if (request["start"] is not null && pipe.SubEntityType == PipeSubEntityType.Straight)
        {
            pipe.StartPoint = PrimitiveAccess.Point(request["start"]);
        }

        if (request["end"] is not null && pipe.SubEntityType == PipeSubEntityType.Straight)
        {
            pipe.EndPoint = PrimitiveAccess.Point(request["end"]);
        }

        foreach (var (side, connector) in new[] { ("start", ConnectorPositionType.Start), ("end", ConnectorPositionType.End) })
        {
            string key = side + "Structure";
            if (request[key] is not null)
            {
                Structure structure = NetworkPartAccess.Find<Structure>(database, transaction, CivilObjectAccess.Text(request, key));
                ObjectId current = side == "start" ? pipe.StartStructureId : pipe.EndStructureId;
                if (current != structure.ObjectId)
                {
                    pipe.ConnectToStructure(connector, structure.ObjectId, request["replaceConnections"]?.GetValue<bool>() == true);
                }
            }

            Point3d position = side == "start" ? pipe.StartPoint : pipe.EndPoint;
            if (request[side] is not null && position.DistanceTo(PrimitiveAccess.Point(request[side])) > 1e-6)
            {
                throw new InvalidOperationException("연결 후 관 중심선 좌표가 요청과 달라 전체 작업을 취소했습니다.");
            }

            string? expected = request["expectedConnections"]?[side]?.GetValue<string>();
            ObjectId connected = side == "start" ? pipe.StartStructureId : pipe.EndStructureId;
            if (expected != NetworkPartAccess.Handle(connected))
            {
                throw new InvalidOperationException("관의 적용 후 연결 상태가 계획과 달라 작업을 취소했습니다.");
            }
        }
    }
}
