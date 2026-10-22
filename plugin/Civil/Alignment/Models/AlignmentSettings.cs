namespace MyCivil3DMcp.Plugin;

public sealed record AlignmentSettings(double ReferenceStation, double[] ReferencePoint, double StationIndexIncrement,
    string SuperelevationType, bool UseDesignSpeed, bool UseDesignCriteriaFile, string? CriteriaFileName,
    bool UseDesignCheckSet, string? DesignCheckSetName, bool IsConnected);
