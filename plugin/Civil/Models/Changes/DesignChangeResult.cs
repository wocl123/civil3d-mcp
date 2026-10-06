namespace MyCivil3DMcp.Plugin;

/// <summary>적용한 변경: 바꾼 뒤 다시 읽은 값.</summary>
public sealed record DesignChangeResult(string Kind, string Handle, double? At, string Property, double Before, double After);
