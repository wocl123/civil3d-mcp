namespace MyCivil3DMcp.Plugin;

/// <summary>한 요청의 모든 변경(Undo 한 번으로 함께 되돌림)과 변경 뒤의 도면 리비전.</summary>
public sealed record DesignChangeOutcome(IReadOnlyList<DesignChangeResult> Changes, string Revision);
