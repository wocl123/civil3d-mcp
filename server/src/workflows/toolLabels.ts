// Korean labels for the palette's progress line while the AI calls tools.
const LABELS: Record<string, string> = {
  get_active_drawing: "도면 정보 읽는 중",
  get_drawing_summary: "도면 전체 요약 읽는 중",
  check_all_alignments: "전체 선형 기준 검토 중",
  list_drawing_layers: "레이어 읽는 중",
  list_drawing_objects: "객체 목록 읽는 중",
  get_drawing_object: "객체 읽는 중",
  get_selection: "선택한 객체 읽는 중",
  capture_drawing: "도면 캡처해서 확인하는 중",
  list_alignments: "선형 목록 읽는 중",
  get_alignment: "선형 읽는 중",
  get_alignment_section: "선형 세부 정보 읽는 중",
  get_profile: "종단 읽는 중",
  get_profile_section: "종단 세부 정보 읽는 중",
  check_alignment_criteria: "평면선형 기준 검토 중",
  check_profile_criteria: "종단 기준 검토 중",
  list_polylines: "폴리라인 목록 읽는 중",
  pick_polyline: "도면에서 폴리라인을 선택하세요 (ESC 취소)",
  plan_alignment_from_polyline: "선형 배치 계산 중",
  apply_drawing_change: "도면에 적용 중",
  read_knowledge_rule: "규칙 확인 중"
};

export function toolLabel(name: string): string {
  return LABELS[name] ?? `${name} 실행 중`;
}
