namespace MyCivil3DMcp.Plugin;

/// <summary>
/// 바꿀 값 하나: 무엇을(kind, handle, 측점 at), 어떤 속성을, 지금 있어야 할 값(from), 새 값(to).
/// Node 서비스가 계산한 수정안으로 만든다.
/// </summary>
public sealed record DesignChangeRequest(string Kind, string Handle, double? At, string Property, double? From, double To);
