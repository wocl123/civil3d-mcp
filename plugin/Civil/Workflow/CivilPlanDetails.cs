using System.Globalization;
using System.Text.Json.Nodes;

namespace MyCivil3DMcp.Plugin;

internal static class CivilPlanDetails
{
    private static readonly Dictionary<string, string> Titles = new() {
        ["workflow.apply"] = "연속 생성 작업", ["alignment.fromPolyline"] = "폴리선에서 선형 생성", ["alignment.geometry"] = "선형 PI·요소 편집",
        ["civilObject.delete"] = "Civil 객체·종속성 삭제", ["pressureRun.delete"] = "압력 관로 런 삭제",
        ["propertySet.change"] = "속성 세트 변경", ["propertyDefinition.change"] = "속성 세트 정의 생성·확장", ["alignment.superelevation"] = "선형 편경사 편집",
        ["parcel.create"] = "Civil 필지 생성", ["parcel.edit"] = "Civil 필지 속성 편집",
        ["surface.analysis"] = "지표면 분석 구간 수정", ["surface.waterdrop"] = "지표면 물 흐름 경로 생성",
        ["label.engineering"] = "Civil 설계 라벨 생성", ["quantityTable.create"] = "객체 기반 수량표 생성", ["quantityTable.refresh"] = "객체 기반 수량표 갱신",
        ["corridor.solids"] = "코리더 솔리드 추출",
        ["alignment.stationEquations"] = "선형 측점 방정식 교체",
        ["sampleLine.edit"] = "횡단추출선 측점·폭·정점 편집", ["sampleLine.batch"] = "횡단추출선 일정 간격 생성",
        ["corridor.split"] = "코리더 구간 분할", ["corridor.merge"] = "코리더 구간 병합", ["corridor.removeRegion"] = "코리더 구간 삭제",
        ["subassembly.parameters"] = "서브어셈블리 입력값 수정",
        ["pressureRun.create"] = "압력 관로 런 생성", ["pressureRun.break"] = "압력 관로 런 분할", ["pressureRun.merge"] = "압력 관로 런 병합", ["pressureRun.profile"] = "압력 관로 런 종단 추종",
        ["catchmentGroup.create"] = "집수구역 그룹 생성", ["catchment.create"] = "집수구역 생성", ["catchment.edit"] = "집수구역 속성 수정",
        ["sampleGroup.create"] = "횡단추출선 그룹 생성", ["sampleGroup.edit"] = "횡단 추출 소스 변경", ["sampleLine.create"] = "횡단추출선 생성",
        ["sectionView.create"] = "횡단뷰 생성", ["sectionView.edit"] = "횡단뷰 범위·위치 수정",
        ["assembly.create"] = "표준횡단 생성", ["assembly.edit"] = "표준횡단 수정", ["corridor.create"] = "코리더 생성",
        ["corridor.baseline"] = "코리더 기준선 추가", ["corridor.region"] = "코리더 구간·타깃·간격 수정", ["corridor.surface"] = "코리더 지표면 생성", ["corridor.rebuild"] = "코리더 재작성",
        ["site.create"] = "부지 생성", ["site.edit"] = "부지 속성 수정", ["pointGroup.create"] = "점 그룹 생성", ["pointGroup.edit"] = "점 그룹 조건 수정",
        ["style.copy"] = "Civil 스타일 복제", ["style.text"] = "라벨 스타일 문자 편집", ["cogo.delete"] = "COGO 점 삭제",
        ["alignment.offset"] = "동적 오프셋 선형 생성", ["profile.pvi"] = "개별 종단 PVI 편집", ["profileView.range"] = "종단뷰 표시 범위 수정",
        ["pressureNetwork.create"] = "압력관망 생성", ["pressureNetwork.edit"] = "압력관망 속성 수정", ["pressurePart.create"] = "압력관 부품 생성", ["pressurePart.edit"] = "압력관 부품 수정",
        ["block.create"] = "블록 정의 생성", ["block.insert"] = "블록 삽입", ["block.attributes"] = "블록 속성 편집", ["hatch.create"] = "해치 생성", ["leader.create"] = "다중 지시선 생성", ["table.create"] = "표 생성",
        ["label.create"] = "Civil 라벨 생성", ["label.edit"] = "Civil 라벨 수정", ["label.delete"] = "Civil 라벨 삭제",
        ["descriptionSet.create"] = "설명 키 세트 생성", ["descriptionKey.set"] = "설명 키 생성·수정", ["pointUdp.create"] = "점 사용자 속성 생성", ["cogo.descriptionKeys"] = "점 설명 키 다시 적용", ["cogo.udp"] = "점 사용자 속성 값 수정"
    };
    private static readonly Dictionary<string, string> Actions = new() {
        ["create"] = "생성", ["add"] = "속성 추가", ["createCurve"] = "편경사 곡선 초기화", ["addStation"] = "편경사 수동 측점 추가",
        ["setSlopes"] = "편경사 경사값 변경", ["setTable"] = "편경사 측점 표 일괄 입력", ["removeStation"] = "편경사 수동 측점 삭제",
        ["movePI"] = "직선 PI 이동", ["appendLine"] = "끝 직선 추가", ["appendArc"] = "끝 원곡선 추가", ["appendSpiral"] = "끝 완화곡선 추가", ["removeLast"] = "끝 요소 삭제", ["arcRadius"] = "원곡선 반지름 변경",
        ["attach"] = "부착", ["detach"] = "분리", ["set"] = "수동 속성값 변경",
        ["copy"] = "복사", ["mirror"] = "대칭", ["offset"] = "오프셋", ["array"] = "배열", ["trim"] = "구간 유지 자르기", ["break"] = "구간 제거 끊기", ["extend"] = "연장", ["vertices"] = "정점 교체", ["polyline3d"] = "3D 폴리선 생성",
        ["fillet"] = "모깎기", ["chamfer"] = "모따기", ["join"] = "결합", ["paste"] = "붙여넣기", ["contours"] = "등고선 정의 추가", ["dem"] = "DEM 정의 추가", ["boundary"] = "경계 추가", ["removeBoundary"] = "경계 제거", ["swapEdge"] = "삼각망 모서리 교환", ["deleteEdge"] = "삼각망 모서리 삭제", ["simplify"] = "단순화", ["extractContours"] = "등고선 추출", ["landxml"] = "LandXML 가져오기"
    };
    internal static string Title(string operation) => Titles.GetValueOrDefault(operation) ?? operation;
    internal static string Action(string action) => Actions.GetValueOrDefault(action) ?? action;
    private static readonly Dictionary<string, string> Labels = new() {
        ["parcel"] = "필지", ["siteName"] = "새 Site 이름", ["address"] = "주소", ["taxId"] = "납세 식별자",
        ["appliesTo"] = "적용 RX 클래스", ["properties"] = "추가 속성 목록", ["default"] = "기본값", ["affected"] = "부착 객체",
        ["curve"] = "편경사 곡선", ["slopes"] = "횡단 경사 비율", ["stations"] = "편경사 측점 표", ["startEntityId"] = "시작 요소 ID", ["endEntityId"] = "끝 요소 ID",
        ["removeParts"] = "관로 부품 삭제", ["removePath"] = "관로 경로 삭제", ["includeDependents"] = "종속 객체 삭제 포함",
        ["definition"] = "속성 세트 정의", ["values"] = "수동 속성값", ["bands"] = "새 분석 구간 전체 목록", ["min"] = "최소", ["max"] = "최대", ["color"] = "ACI 색상",
        ["entityId"] = "요소 ID", ["startRadius"] = "시작 반지름", ["endRadius"] = "끝 반지름", ["length"] = "길이", ["spiralType"] = "완화곡선 종류",
        ["table"] = "수량표", ["metric"] = "측정 항목", ["labelSet"] = "라벨 세트",
        ["codes"] = "추출할 셰이프 코드",
        ["equations"] = "새 측점 방정식 전체 목록", ["rawStationBack"] = "원시 후측점", ["stationAhead"] = "전측점", ["comment"] = "설명",
        ["leftWidth"] = "왼쪽 폭", ["rightWidth"] = "오른쪽 폭", ["vertices"] = "수정 정점", ["lockToStation"] = "측점 고정",
        ["otherRegion"] = "뒤 병합 구간", ["parameters"] = "입력 매개변수", ["key"] = "매개변수 키",
        ["run"] = "관로 런", ["otherRun"] = "상대 관로 런", ["cover"] = "토피", ["autoAddBends"] = "곡관 자동 추가",
        ["verticalOffset"] = "종단 수직 오프셋", ["keepFollow"] = "종단 추종 유지", ["runoffCoefficient"] = "유출계수", ["curveNumber"] = "Curve Number",
        ["action"] = "작업", ["kind"] = "종류", ["name"] = "이름", ["newName"] = "새 이름", ["description"] = "설명",
        ["handles"] = "대상 핸들", ["handle"] = "대상 핸들", ["source"] = "원본 핸들", ["layer"] = "레이어", ["style"] = "스타일",
        ["moveBy"] = "이동·배열 간격", ["axisStart"] = "대칭축 시작", ["axisEnd"] = "대칭축 끝", ["eraseSource"] = "원본에서 대칭",
        ["distance"] = "거리", ["count"] = "총 개수", ["points"] = "지정 좌표", ["closed"] = "닫기", ["bulges"] = "벌지",
        ["atStart"] = "시작점 연장", ["point"] = "목표점", ["fromDistance"] = "시작 누가거리", ["toDistance"] = "끝 누가거리",
        ["featureLine"] = "형상선", ["surface"] = "지표면", ["sourceSurface"] = "붙여넣을 지표면", ["insertIntermediate"] = "중간 표고점 추가",
        ["elevations"] = "점 표고", ["index"] = "인덱스", ["elevation"] = "표고", ["insertPI"] = "추가 PI", ["deletePI"] = "삭제 PI",
        ["insertElevation"] = "추가 표고점", ["deleteElevation"] = "삭제 표고점", ["group"] = "그룹", ["sources"] = "횡단 소스",
        ["sampleLine"] = "횡단추출선", ["sectionView"] = "횡단뷰", ["position"] = "WCS 위치", ["alignment"] = "선형",
        ["elevationMin"] = "최소 표고", ["elevationMax"] = "최대 표고", ["offsetLeft"] = "왼쪽 범위", ["offsetRight"] = "오른쪽 범위",
        ["assembly"] = "표준횡단", ["subassembly"] = "서브어셈블리", ["corridor"] = "코리더", ["baselineName"] = "기준선",
        ["profile"] = "종단", ["regionName"] = "구간", ["startStation"] = "시작 측점", ["endStation"] = "끝 측점",
        ["frequency"] = "직선 적용 간격", ["curveFrequency"] = "곡선 적용 간격", ["spiralFrequency"] = "완화곡선 적용 간격",
        ["profileFrequency"] = "종곡선 적용 간격", ["targets"] = "타깃", ["logicalName"] = "타깃 이름", ["linkCodes"] = "링크 코드",
        ["site"] = "부지", ["query"] = "점 포함·제외 조건", ["includeNumbers"] = "포함 점번호", ["excludeNumbers"] = "제외 점번호",
        ["includeDescriptions"] = "포함 설명", ["excludeDescriptions"] = "제외 설명", ["includeElevations"] = "포함 표고", ["excludeElevations"] = "제외 표고",
        ["all"] = "모두 포함", ["offset"] = "오프셋", ["station"] = "측점", ["profileView"] = "종단뷰", ["stationStart"] = "표시 시작 측점", ["stationEnd"] = "표시 끝 측점",
        ["network"] = "관망", ["partsList"] = "부품 목록", ["sizeGuid"] = "정확한 부품 규격", ["start"] = "시작 중심점", ["end"] = "끝 중심점",
        ["midPoint"] = "곡선 통과점", ["connectPipe"] = "연결할 관", ["port"] = "부품 포트", ["pipePort"] = "관 포트", ["disconnectPort"] = "해제할 포트",
        ["basePoint"] = "기준점", ["scale"] = "축척", ["rotationDegrees"] = "회전각(도)", ["attributes"] = "블록 속성", ["pattern"] = "해치 패턴",
        ["patternScale"] = "패턴 축척", ["text"] = "문자", ["height"] = "문자 높이", ["arrowPoint"] = "화살표 위치", ["textPosition"] = "문자 위치",
        ["rows"] = "표 내용", ["rowHeight"] = "행 높이", ["columnWidth"] = "열 너비", ["radius"] = "반지름", ["distanceA"] = "첫 선 모따기 거리", ["distanceB"] = "둘째 선 모따기 거리",
        ["linetype"] = "선종류", ["lineweight"] = "선가중치(1/100mm)", ["transparency"] = "투명도(%)", ["plottable"] = "출력 포함",
        ["midOrdinate"] = "중간 종거 거리", ["maximumDistance"] = "최대 거리", ["weedingDistance"] = "간격 솎기", ["weedingAngle"] = "각도 솎기(라디안)",
        ["path"] = "입력 파일", ["xmlSurface"] = "LandXML 지표면 이름", ["boundaryType"] = "경계 종류", ["x"] = "X", ["y"] = "Y", ["z"] = "Z",
        ["percentage"] = "제거 비율(%)", ["maximumElevationChange"] = "최대 표고 변화", ["interval"] = "간격", ["secondPoint"] = "둘째 점",
        ["ratio"] = "구간 비율", ["markerStyle"] = "마커 스타일", ["lineStyle"] = "선 라벨 스타일", ["curveStyle"] = "곡선 라벨 스타일",
        ["pinned"] = "고정", ["flipped"] = "뒤집기", ["overrides"] = "문자 재정의", ["clearOverrides"] = "문자 재정의 초기화",
        ["styleKind"] = "스타일 종류", ["component"] = "문자 구성요소", ["contents"] = "문자 내용", ["set"] = "설명 키 세트", ["code"] = "설명 코드",
        ["format"] = "설명 형식", ["labelStyle"] = "점 라벨 스타일", ["classification"] = "사용자 속성 분류", ["type"] = "속성 형식", ["value"] = "값", ["sampled"] = "추출"
    };
    public static IEnumerable<string> Describe(JsonObject request) => request.Where(k => Labels.ContainsKey(k.Key))
        .Select(k => Labels[k.Key] + ": " + (k.Key == "action" ? Action(k.Value?.ToString() ?? "") : Format(k.Value)));
    private static string Format(JsonNode? value)
    {
        if (value is null) return "없음";
        if (value is JsonObject p && p.ContainsKey("x") && p.ContainsKey("y") && p.ContainsKey("z"))
            return PrimitiveAccess.PointText(PrimitiveAccess.Point(p));
        if (value is JsonObject obj) return string.Join(", ", obj.Select(k => (Labels.GetValueOrDefault(k.Key) ?? k.Key) + "=" + Format(k.Value)));
        if (value is JsonArray array) return string.Join("; ", array.Take(12).Select(Format))
            + (array.Count > 12 ? $"; 외 {array.Count - 12}개 (계획에는 전체 포함)" : "");
        if (value.GetValueKind() == System.Text.Json.JsonValueKind.True) return "예";
        if (value.GetValueKind() == System.Text.Json.JsonValueKind.False) return "아니요";
        if (value.GetValueKind() == System.Text.Json.JsonValueKind.Number)
            return CivilObjectAccess.Number(value).ToString("0.########", CultureInfo.InvariantCulture);
        return value.ToString();
    }
}
