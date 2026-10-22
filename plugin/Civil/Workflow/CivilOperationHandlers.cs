using System.Text.Json.Nodes;
using Autodesk.AutoCAD.DatabaseServices;

namespace MyCivil3DMcp.Plugin;

// Each database operation registers validation and application together.
// CivilPlans owns the transaction; document/UI operations remain outside this registry.
internal static class CivilOperationHandlers
{
    private delegate string ValidateOperation(Database db, Transaction tr, JsonObject request, List<string> details);
    private delegate object ApplyOperation(Database db, Transaction tr, JsonObject request);
    private sealed record Handler(ValidateOperation Validate, ApplyOperation Apply);
    private static readonly IReadOnlyDictionary<string, Handler> Operations = Create();

    private static IReadOnlyDictionary<string, Handler> Create()
    {
        Dictionary<string, Handler> operations = new(StringComparer.Ordinal);
        void Register(ValidateOperation validate, ApplyOperation apply, params string[] names)
        {
            var handler = new Handler(validate, apply);
            foreach (string name in names) operations.Add(name, handler);
        }

        Register(AlignmentFromPolyline.Validate, AlignmentFromPolyline.Apply,
            "alignment.fromPolyline");
        Register(AlignmentGeometryChanges.Validate, AlignmentGeometryChanges.Apply,
            "alignment.geometry");
        Register(CivilObjectDeletion.Validate, CivilObjectDeletion.Apply,
            "civilObject.delete");
        Register(PropertySetChanges.Validate, PropertySetChanges.Apply,
            "propertySet.change");
        Register(PropertyDefinitionChanges.Validate, PropertyDefinitionChanges.Apply,
            "propertyDefinition.change");
        Register(SuperelevationChanges.Validate, SuperelevationChanges.Apply,
            "alignment.superelevation");
        Register(ParcelChanges.Validate, ParcelChanges.Apply,
            "parcel.create", "parcel.edit");
        Register(SurfaceAnalysisChanges.Validate, SurfaceAnalysisChanges.Apply,
            "surface.analysis", "surface.waterdrop");
        Register(EngineeringLabelChanges.Validate, EngineeringLabelChanges.Apply,
            "label.engineering");
        Register(CivilQuantityTables.Validate, CivilQuantityTables.Apply,
            "quantityTable.create", "quantityTable.refresh");
        Register(StationEquationChanges.Validate, StationEquationChanges.Apply,
            "alignment.stationEquations");
        Register(PressureRunChanges.Validate, PressureRunChanges.Apply,
            "pressureRun.create", "pressureRun.break", "pressureRun.merge", "pressureRun.profile", "pressureRun.delete");
        Register(CatchmentChanges.Validate, CatchmentChanges.Apply,
            "catchmentGroup.create", "catchment.create", "catchment.edit");
        Register(SampleLineEditing.Validate, SampleLineEditing.Apply,
            "sampleLine.edit", "sampleLine.batch");
        Register(CorridorEditing.Validate, CorridorEditing.Apply,
            "corridor.split", "corridor.merge", "corridor.removeRegion", "corridor.solids", "subassembly.parameters");
        Register(FeatureLineChanges.Validate, FeatureLineChanges.Apply,
            "featureLine.create", "featureLine.edit");
        Register(GeometryExtensions.Validate, GeometryExtensions.Apply,
            "geometry.extend");
        Register(GeometryCorners.Validate, GeometryCorners.Apply,
            "geometry.corner");
        Register(CivilLabelChanges.Validate, CivilLabelChanges.Apply,
            "label.create", "label.edit", "label.delete", "style.text");
        Register(PointFileImport.Validate, PointFileImport.Apply,
            "cogo.import");
        Register(NetworkRules.Validate, NetworkRules.Apply,
            "network.rules");
        Register(PointMetadata.Validate, PointMetadata.Apply,
            "descriptionSet.create", "descriptionKey.set", "pointUdp.create", "cogo.descriptionKeys", "cogo.udp");
        Register(SurfaceExtensions.Validate, SurfaceExtensions.Apply,
            "surface.definition");
        Register(LayerProperties.Validate, LayerProperties.Apply,
            "layer.properties");
        Register(AnnotationExtensions.Validate, AnnotationExtensions.Apply,
            "block.create", "block.insert", "block.attributes", "hatch.create", "leader.create", "table.create");
        Register(CivilUtilityChanges.Validate, CivilUtilityChanges.Apply,
            "site.create", "site.edit", "pointGroup.create", "pointGroup.edit", "style.copy", "cogo.delete",
            "alignment.offset", "profile.pvi", "profileView.range");
        Register(PressureChanges.Validate, PressureChanges.Apply,
            "pressureNetwork.create", "pressureNetwork.edit", "pressurePart.create", "pressurePart.edit");
        Register(SectionChanges.Validate, SectionChanges.Apply,
            "sampleGroup.create", "sampleGroup.edit", "sampleLine.create", "sectionView.create", "sectionView.edit");
        Register(CorridorChanges.Validate, CorridorChanges.Apply,
            "assembly.create", "assembly.edit", "corridor.create", "corridor.baseline", "corridor.region",
            "corridor.surface", "corridor.rebuild");
        Register(SurfaceChanges.Validate, SurfaceChanges.Apply,
            "surface.create", "surface.edit", "surface.delete");
        Register(SurfaceBatchDeletion.Validate, SurfaceBatchDeletion.Apply,
            "surface.deleteMany");
        Register(VolumeChanges.Validate, VolumeChanges.Apply,
            "volume.create", "volume.edit");
        Register(CogoChanges.Validate, CogoChanges.Apply,
            "cogo.create", "cogo.edit");
        Register(NetworkPartChanges.Validate, NetworkPartChanges.Apply,
            "pipe.create", "pipe.edit", "structure.create", "structure.edit");
        Register(NetworkChanges.Validate, NetworkChanges.Apply,
            "network.delete");
        Register(NetworkProperties.Validate, NetworkProperties.Apply,
            "network.create", "network.edit");
        Register(ProfileViewChanges.Validate, ProfileViewChanges.Apply,
            "profileView.create", "profileView.edit");
        Register(ProfileChanges.Validate, ProfileChanges.Apply,
            "profile.create", "profile.edit");
        Register(DimensionChanges.Validate, DimensionChanges.Apply,
            "dimension.create", "dimension.edit", "dimension.delete");
        Register(PointChanges.Validate, PointChanges.Apply,
            "point.create", "point.edit", "point.delete");
        Register(DrawingCleanup.Validate, (db, tr, request) => new { deleted = PrimitiveAccess.Erase(db, tr, request) },
            "cleanup.delete");
        Register(TextChanges.Validate, TextChanges.Apply,
            "text.create", "text.edit", "text.delete");
        Register(GeometryEditing.Validate, GeometryEditing.Apply,
            "geometry.edit");
        Register(GeometryChanges.Validate, GeometryChanges.Apply,
            "geometry.create", "geometry.delete");
        return operations;
    }

    public static string Validate(string operation, Database db, Transaction tr, JsonObject request, List<string> details)
        => Find(operation).Validate(db, tr, request, details);

    public static object Apply(string operation, Database db, Transaction tr, JsonObject request)
        => Find(operation).Apply(db, tr, request);

    private static Handler Find(string operation) => Operations.TryGetValue(operation, out Handler? handler)
        ? handler : throw new ArgumentException("지원하지 않는 작업입니다.");
}
