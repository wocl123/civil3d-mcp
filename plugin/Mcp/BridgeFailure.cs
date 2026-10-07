namespace MyCivil3DMcp.Plugin;

// 브리지의 명시적 오류 코드와 도면 변경 여부를 Node까지 보존한다.
internal sealed class BridgeFailure(string kind, string message, object? drawingChanged = null) : Exception(message)
{
    public string Kind { get; } = kind;
    public object DrawingChanged { get; } = drawingChanged ?? false;
}
