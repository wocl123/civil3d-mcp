using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.Civil;
using Autodesk.Civil.ApplicationServices;
using Autodesk.Civil.DatabaseServices;
using Surface = Autodesk.Civil.DatabaseServices.Surface;
using DBObject = Autodesk.AutoCAD.DatabaseServices.DBObject;

namespace MyCivil3DMcp.Plugin;

// Civil 연결은 AutoCAD persistent reactor에 모두 나타나지 않는다. 설계 소스도 직접 확인한다.
internal static class SurfaceReferences
{
    public static string[] Read(Database database, Transaction transaction, Surface surface)
    {
        HashSet<string> references = new(StringComparer.Ordinal);
        foreach (ObjectId id in surface.GetPersistentReactorIds())
        {
            if (!id.IsNull && !id.IsErased)
            {
                DBObject item = transaction.GetObject(id, OpenMode.ForRead);
                references.Add($"{item.GetType().Name} [{item.Handle}]");
            }
        }

        foreach (Profile profile in CivilObjectAccess.All<Profile>(transaction, database))
        {
            if (profile.ProfileType == ProfileType.EG && profile.DataSourceId == surface.ObjectId)
            {
                references.Add($"지표면 종단 {profile.Name} [{profile.Handle}]");
            }
        }

        CheckSurfaces(database, transaction, surface, references);
        CheckCorridors(database, transaction, surface, references);
        CheckSections(database, transaction, surface, references);
        return references.OrderBy(item => item, StringComparer.Ordinal).ToArray();
    }

    private static void CheckSurfaces(Database database, Transaction transaction, Surface source,
        HashSet<string> references)
    {
        foreach (Surface surface in CivilObjectAccess.All<Surface>(transaction, database))
        {
            if (surface.ObjectId == source.ObjectId)
            {
                continue;
            }

            VolumeSurfaceProperties? volume = surface switch
            {
                TinVolumeSurface tin => tin.GetVolumeProperties(),
                GridVolumeSurface grid => grid.GetVolumeProperties(),
                _ => null
            };
            if (volume is not null && (volume.BaseSurface == source.ObjectId || volume.ComparisonSurface == source.ObjectId))
            {
                references.Add($"토공량 지표면 {surface.Name} [{surface.Handle}]");
            }

            bool pasted = Enumerable.Range(0, surface.Operations.Count).Select(index => surface.Operations[index])
                .OfType<SurfaceOperationPasteSurface>()
                .Any(operation => operation.SurfaceId == source.ObjectId);
            if (pasted)
            {
                references.Add($"붙여넣기 지표면 {surface.Name} [{surface.Handle}]");
            }
        }
    }

    private static void CheckCorridors(Database database, Transaction transaction, Surface source,
        HashSet<string> references)
    {
        CivilDocument civil = CivilDocument.GetCivilDocument(database);
        foreach (ObjectId id in civil.CorridorCollection)
        {
            Corridor corridor = (Corridor)transaction.GetObject(id, OpenMode.ForRead);
            bool targeted = corridor.GetTargets().Cast<SubassemblyTargetInfo>()
                .Any(target => target.TargetIds.Cast<ObjectId>().Contains(source.ObjectId));
            bool owned = corridor.CorridorSurfaces.Cast<CorridorSurface>().Any(surface => surface.SurfaceId == source.ObjectId);
            if (targeted || owned)
            {
                references.Add($"코리더 {corridor.Name} [{corridor.Handle}]");
            }
        }
    }

    private static void CheckSections(Database database, Transaction transaction, Surface source,
        HashSet<string> references)
    {
        foreach (Alignment alignment in CivilObjectAccess.All<Alignment>(transaction, database))
        {
            foreach (ObjectId id in alignment.GetSampleLineGroupIds())
            {
                SampleLineGroup group = (SampleLineGroup)transaction.GetObject(id, OpenMode.ForRead);
                bool sampled = SectionChanges.Sources(database, group.ObjectId)
                    .Any(section => section.Handle == source.Handle.ToString() && section.Sampled);
                if (sampled)
                {
                    references.Add($"횡단 추출선 그룹 {group.Name} [{group.Handle}]");
                }
            }
        }
    }
}
