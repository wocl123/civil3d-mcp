namespace MyCivil3DMcp.Plugin;

public sealed record ProfileSettings(string UpdateMode, string? DataSource, double? Offset, string? ParentProfile,
    bool DesignSpeedBased, bool UseDesignCriteriaFile, bool UseDesignCheckSet, string? DesignCheckSetName);
