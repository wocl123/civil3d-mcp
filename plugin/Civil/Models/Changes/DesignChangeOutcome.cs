namespace MyCivil3DMcp.Plugin;

/// <summary>All changes of one request, applied together as one undo step, and the drawing revision after them.</summary>
public sealed record DesignChangeOutcome(IReadOnlyList<DesignChangeResult> Changes, string Revision);
