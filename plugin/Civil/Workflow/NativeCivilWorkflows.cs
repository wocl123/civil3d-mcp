using System.IO;
using System.IO.Compression;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Autodesk.AutoCAD.ApplicationServices;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.EditorInput;

namespace MyCivil3DMcp.Plugin;

// Interactive companion workflows are explicitly separate from automatic CRUD.
// Only installed, allowlisted single-command macros are launchable. No raw command input is accepted.
internal static class NativeCivilWorkflows
{
    private static readonly Dictionary<string, (string Uid, string Label)> Allowed = new() {
        ["alignment.layout"] = ("AECC_AeccAlignmentLayout", "선형 배치·요소 편집 도구"),
        ["alignment.connected"] = ("AECC_CreateAlignmentConnected", "연결 선형 생성"),
        ["catchment.surface"] = ("AECC_CreateCatchmentFromSurface", "지표면에서 집수구역 생성"),
        ["catchment.object"] = ("AECC_CreateCatchmentFromObject", "객체에서 집수구역 생성"),
        ["catchment.edit"] = ("AECC_EditCatchmentAreaProps", "집수구역 수문 속성 편집"),
        ["catchment.label"] = ("AECC_AddCatchmentLabel", "집수구역 라벨 생성"),
        ["network.interference"] = ("AECC_NtwksInterferenceCheck", "관망 간섭 검사 생성"),
        ["network.interferenceProperties"] = ("AECC_EditInterferenceCheckProperties", "관망 간섭 검사 속성"),
        ["corridor.solids"] = ("AECC_ExtractCorridorSolids", "코리더 솔리드 추출"),
        ["corridor.splitRegion"] = ("AECC_SplitCorrRegion", "코리더 구간 분할"),
        ["corridor.mergeRegions"] = ("AECC_MergeCorrRegions", "코리더 구간 병합"),
        ["pressureRun.layout"] = ("AECC_AddPipeRun", "압력 관로 런 배치"),
        ["pressureRun.fromObject"] = ("AECC_AddPipeRunFromObj", "객체에서 압력 관로 런 생성"),
        ["pressureRun.fromParts"] = ("AECC_CreatePipeRunFromParts", "기존 부품에서 관로 런 생성"),
        ["pressureRun.profile"] = ("AECC_PipeRunProfileSettings", "압력 관로 런 종단·토피 설정"),
        ["pressureRun.break"] = ("AECC_BreakPipeRun", "압력 관로 런 분할"),
        ["pressureRun.merge"] = ("AECC_MergePipeRuns", "압력 관로 런 병합"),
        ["pressureRun.relink"] = ("AECC_RelinkPipeRun", "압력 관로 런 재연결"),
        ["templates.attach"] = ("AECC_AttachReferenceTemplate", "참조 템플릿 연결"),
        ["templates.defaults"] = ("RBN_ReferenceTemplateSetDefaults", "참조 템플릿 기본 설정"),
        ["propertySets.define"] = ("AECC_PropertySetDefine", "속성 세트 정의"),
        ["rail.alignment"] = ("AECC_AeccRailAlignmentLayout", "철도 선형 배치"),
        ["rail.lines"] = ("AECC_AeccCreateRailLines", "레일 선 생성"),
        ["rail.editLines"] = ("AECC_AeccEditRailLines", "레일 선 편집"),
        ["rail.exportLines"] = ("AECC_AeccExportRailLines", "레일 선 내보내기"),
        ["rail.cant"] = ("AECC_CantEditor", "철도 캔트 계산·편집"),
        ["rail.cantView"] = ("AECC_CantView", "철도 캔트 뷰 생성"),
        ["rail.platform"] = ("AECC_AeccRailPlatformEdgeCreate", "철도 플랫폼 가장자리 생성"),
        ["rail.editPlatform"] = ("AECC_AeccRailPlatformEdgeEdit", "철도 플랫폼 가장자리 편집"),
        ["grading.create"] = ("Aecc_GrdLayout", "정지 작성 도구"),
        ["grading.group"] = ("AECC_CreateGradingGroup", "정지 그룹 생성"),
        ["grading.edit"] = ("Aecc_GrdEditGrd", "정지 편집"),
        ["grading.balance"] = ("Aecc_GrdVolTools", "정지 토량 조정"),
        ["grading.infill"] = ("AeccGrdInfill", "정지 내부 채우기"),
        ["parcel.create"] = ("AECC_ParConvertObjects", "객체에서 필지 생성"),
        ["parcel.layout"] = ("AECC_ParLayout", "필지 배치·분할"),
        ["parcel.edit"] = ("AECC_EditParcels", "필지 경계 편집"),
        ["parcel.properties"] = ("AECC_ParPropsEdit", "필지 속성 편집"),
        ["parcel.labels"] = ("AECC_ParLotLabels", "필지 라벨 작성"),
        ["parcel.table"] = ("AECC_ParAreaTbl", "필지 면적표 작성"),
        ["survey.database"] = ("AECC_SvToggleTS", "측량 작업공간"),
        ["survey.import"] = ("AECC_ImportSurveyData", "측량자료 가져오기"),
        ["survey.settings"] = ("AECC_SvDbaseSettings", "측량 DB 설정"),
        ["shortcuts.create"] = ("AECC_CreateDataShortcuts", "데이터 바로가기 생성"),
        ["shortcuts.manage"] = ("Aecc_ManageDataShortcuts", "데이터 바로가기 참조 관리"),
        ["shortcuts.validate"] = ("AECC_ValidateDataShortcuts", "데이터 바로가기 검사"),
        ["shortcuts.folder"] = ("AECC_SetShortcutsFolder", "데이터 바로가기 작업 폴더"),
        ["landxml.import"] = ("AECC_LandXMLIn", "LandXML 가져오기"),
        ["landxml.export"] = ("AECC_LandXMLOut", "LandXML 내보내기"),
        ["sheets.frames"] = ("AECC_CreateViewFrames", "뷰 프레임 생성"),
        ["sheets.create"] = ("AECC_CreateSheets", "시트 생성"),
        ["sheets.frameEdit"] = ("AECC_ViewFrameProperties", "뷰 프레임 편집"),
        ["intersection.create"] = ("AECC_CreateIntersection", "교차로 생성"),
        ["intersection.edit"] = ("AECC_EditIntersectionProperties", "교차로 편집"),
        ["intersection.offsets"] = ("AECC_EditIntersectionOffsets", "교차로 오프셋 편집"),
        ["superelevation.edit"] = ("AECC_SuperelevationEditor", "편경사 계산·편집"),
        ["superelevation.table"] = ("AECC_SuperelevationTabularView", "편경사 테이블 편집"),
        ["surface.pointFile"] = ("AECC_AddSurfacePointFile", "지표면 점 파일 추가"),
        ["featureLine.curve"] = ("AECC_GradingEditCurve", "형상선 곡선 편집"),
        ["featureLine.offset"] = ("AECC_GrdOfstFl", "형상선 오프셋"),
        ["featureLine.smooth"] = ("AECC_GrdSmoothFl", "형상선 완화")
        , ["points.import"] = ("AECC_ImportPoints", "점 파일 가져오기")
        , ["points.export"] = ("AECC_ExportPoints", "점 파일 내보내기")
        , ["styles.import"] = ("AECC_ImportStyles", "스타일·설정 가져오기")
        , ["subassembly.fromPolyline"] = ("AECC_CreateSubassemblyFromPoly", "폴리선에서 서브어셈블리 생성")
        , ["network.layout"] = ("AECC_AeccNewNetwork", "중력식 관망 배치")
        , ["network.fromObject"] = ("AECC_AeccCreateNetworkFromPolyline", "객체에서 중력식 관망 생성")
        , ["network.partsList"] = ("AECC_NtwksCreatePartsList", "중력식 관망 부품 목록 생성")
        , ["network.labels"] = ("AECC_AddNetworkPlanLabels", "관망 평면 라벨 작성")
        , ["network.pipeTable"] = ("AECC_AddNetworkPipeTable", "관 수량표 작성")
        , ["network.structureTable"] = ("AECC_AddNetworkStructTable", "구조물 수량표 작성")
        , ["massHaul.create"] = ("AECC_CreateMassHaulDiagram", "토적 곡선도 생성")
        , ["profileView.properties"] = ("AECC_EditProfileViewProperties", "종단뷰 밴드·격자·분할 편집")
        , ["materials.compute"] = ("AECC_ComputeMaterials", "재료별 토량 계산")
        , ["alignment.properties"] = ("AECC_EditAlignmentProperties", "선형 측점 방정식·설계 속성 편집")
        , ["alignment.widening"] = ("AECC_AddWidening", "오프셋 선형 확폭 추가")
        , ["alignment.autoWidening"] = ("AECC_AddAutomaticWidening", "오프셋 선형 자동 확폭")
        , ["alignment.labels"] = ("AECC_EditAlignmentLabels", "선형 라벨 세트 편집")
        , ["alignment.style"] = ("AECC_EditAlignmentStyle", "선형 스타일 편집")
        , ["profile.geometry"] = ("AECC_ProfilesEdit", "종단 PVI·종곡선 편집")
        , ["profile.properties"] = ("AECC_EditProfileProperties", "종단 동적·정적 및 속성 편집")
        , ["profile.labels"] = ("AECC_EditProfileLabels", "종단 라벨 편집")
        , ["profile.style"] = ("AECC_EditProfileStyle", "종단 스타일 편집")
        , ["styles.label"] = ("AECC_EditLabelStyle", "라벨 스타일 구성 편집")
        , ["subassembly.create"] = ("AECC_CreateNewSubassembly", "서브어셈블리 생성")
        , ["subassembly.properties"] = ("AECC_EditSubassemblyProperties", "서브어셈블리 치수·경사 편집")
        , ["surface.create"] = ("AECC_AeccSurfaceCreate", "TIN·그리드 지표면 생성")
        , ["surface.gridDem"] = ("AECC_AeccSurfaceGridFromDEM", "DEM에서 그리드 지표면 생성")
        , ["surface.smooth"] = ("AECC_SmoothSurface", "지표면 스무딩")
        , ["surface.tinImport"] = ("AECC_AeccSurfaceImportXMLTIN", "TIN 파일에서 지표면 생성")
        , ["sections.lines"] = ("AECC_AeccCreateSampleLine", "횡단추출선 일괄 생성")
        , ["sections.views"] = ("AECC_AeccCreateSectionView", "횡단뷰 배치")
        , ["sections.sheets"] = ("AECC_CreateSectionSheets", "횡단 시트 생성")
        , ["output.pageSetup"] = ("ID_PlotSetup", "페이지 설정")
        , ["output.plot"] = ("ID_Print", "도면 인쇄·PDF 출력")
        , ["output.batchPlot"] = ("ID_Pub", "도면 일괄 출력")
    };
    private sealed record Entry(string Key, string Label, string Command);
    private sealed record Job(string Drawing, string Revision, Entry Entry, ObjectId[] Ids, long Created);
    private static readonly Dictionary<string, Job> Jobs = new();
    private static Entry[]? _catalog;

    private static Entry[] Catalog()
    {
        if (_catalog is not null) return _catalog;
        string folder = Path.GetDirectoryName(typeof(Autodesk.Civil.ApplicationServices.CivilDocument).Assembly.Location)!;
        string path = Path.Combine(folder, "UserDataCache", "Support", "civil.cuix");
        using ZipArchive archive = ZipFile.OpenRead(path);
        Dictionary<string, string> macros = new(StringComparer.OrdinalIgnoreCase);
        foreach (var item in archive.Entries.Where(e => e.FullName.EndsWith(".cui") || e.FullName.EndsWith(".xml")))
        {
            using StreamReader reader = new(item.Open());
            string xml = reader.ReadToEnd();
            foreach (Match macro in Regex.Matches(xml, "<MenuMacro\\b[^>]*UID=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</MenuMacro>"))
            {
                Match command = Regex.Match(macro.Groups[2].Value, "<Command>\\^C\\^C_([A-Za-z][A-Za-z0-9]*)\\s*</Command>");
                if (command.Success) macros[macro.Groups[1].Value] = command.Groups[1].Value;
            }
        }
        _catalog = Allowed.Where(k => macros.ContainsKey(k.Value.Uid)).Select(k => new Entry(k.Key, k.Value.Label, macros[k.Value.Uid])).ToArray();
        return _catalog;
    }
    public static object List() => new { mode = "interactive", automaticCrud = false,
        items = Catalog().Select(e => new { workflow = e.Key, label = e.Label, command = e.Command,
            requiresUserInput = true }).ToArray(), note = "작업창·기본 명령 연결입니다. 객체 생성·수정 완료가 아니며 Civil 3D에서 입력과 결과 확인이 필요합니다." };
    public static string Validate(Database db, Transaction tr, JsonObject r, List<string> details)
    {
        Entry e = Catalog().SingleOrDefault(e => e.Key == CivilObjectAccess.Text(r, "workflow")) ?? throw new ArgumentException("설치된 목록에 없는 기본 작업입니다. 목록을 먼저 확인하세요.");
        if (r["handles"] is JsonArray handles)
        {
            if (handles.Count is < 1 or > 1000) throw new ArgumentException("대상은 1~1000개입니다.");
            foreach (JsonNode? h in handles)
            {
                var entity = CivilObjectAccess.ByHandle(tr, db, h!.ToString()); PrimitiveAccess.Writable(db, tr, entity);
                if (entity is Autodesk.Civil.DatabaseServices.Entity c) CivilObjectAccess.Editable(c);
            }
        }
        r["command"] = e.Command;
        details.Add($"{e.Label}: Civil 3D 기본 작업을 엽니다 ({e.Command}).");
        details.Add("대화형 기능: 생성·수정 자동 완료가 아닙니다. Civil 3D 명령줄·작업창에서 필요한 조건을 입력하고 결과를 확인하세요. 취소는 Esc, 실제 편집은 Civil 3D Undo를 사용하세요.");
        return e.Label + " 열기 (대화형)";
    }
    public static object Queue(Document doc, JsonObject r)
    {
        Entry e = Catalog().Single(e => e.Key == CivilObjectAccess.Text(r, "workflow"));
        foreach (string key in Jobs.Where(j => Environment.TickCount64 - j.Value.Created > 30000).Select(j => j.Key).ToArray()) Jobs.Remove(key);
        if (Jobs.Count >= 16) throw new ArgumentException("기본 작업 요청이 대기 중입니다.");
        ObjectId[] ids = Array.Empty<ObjectId>();
        using (Transaction tr = doc.Database.TransactionManager.StartTransaction())
            if (r["handles"] is JsonArray handles) ids = handles.Select(h => CivilObjectAccess.ByHandle(tr, doc.Database, h!.ToString()).ObjectId).ToArray();
        string token = Guid.NewGuid().ToString("N");
        Jobs[token] = new Job(DrawingRevisions.Id(doc.Database), DrawingRevisions.Of(doc.Database), e, ids, Environment.TickCount64);
        doc.SendStringToExecute($"_.MYC3DNATIVEWORKFLOW {token} ", true, false, false);
        return new { mode = "interactive", status = "queued", automaticCrud = false, workflow = e.Key, command = e.Command,
            note = "기본 작업 실행 대기입니다. 생성·수정 결과는 아직 확인되지 않았습니다." };
    }
    public static void Open(Document doc)
    {
        PromptResult input = doc.Editor.GetString(new PromptStringOptions("\n기본 작업 요청 ID: ") { AllowSpaces = false });
        if (input.Status != PromptStatus.OK) return;
        try
        {
            if (!Jobs.Remove(input.StringResult, out Job? job) || Environment.TickCount64 - job.Created > 30000)
                throw new ArgumentException("기본 작업 요청이 없거나 만료됐습니다.");
            if (job.Drawing != DrawingRevisions.Id(doc.Database) || job.Revision != DrawingRevisions.Of(doc.Database) || job.Ids.Any(i => !i.IsValid || i.IsErased))
                throw new ArgumentException("도면 또는 대상이 바뀌었습니다. 다시 요청하세요.");
            doc.Editor.SetImpliedSelection(job.Ids);
            doc.Editor.WriteMessage($"\n{job.Entry.Label}: 필요한 조건을 Civil 3D에서 입력하세요. 완료 여부는 결과를 직접 확인해야 합니다.\n");
            doc.SendStringToExecute("_." + job.Entry.Command + " ", true, false, false);
        }
        catch (System.Exception ex) { NodeService.LogBridgeError("native.workflow", ex); doc.Editor.WriteMessage("\n기본 작업 실행 실패: " + ex.Message); }
    }
}
