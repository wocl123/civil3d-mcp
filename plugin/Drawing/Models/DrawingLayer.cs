namespace MyCivil3DMcp.Plugin;

public sealed record DrawingLayer(string Name, bool IsOff, bool IsFrozen, bool IsLocked,
    int ObjectCount, IReadOnlyDictionary<string, int> ObjectTypes);
