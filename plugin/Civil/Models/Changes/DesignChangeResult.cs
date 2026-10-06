namespace MyCivil3DMcp.Plugin;

/// <summary>A change as applied: the value read back after the change.</summary>
public sealed record DesignChangeResult(string Kind, string Handle, double? At, string Property, double Before, double After);
