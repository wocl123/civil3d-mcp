namespace MyCivil3DMcp.Plugin;

/// <summary>
/// One value to change: what (kind, handle, station), which property, the value it must
/// still have (from), and the new value (to). Built by the Node service from a computed fix.
/// </summary>
public sealed record DesignChangeRequest(string Kind, string Handle, double? At, string Property, double? From, double To);
