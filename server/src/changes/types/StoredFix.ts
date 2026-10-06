import type { AlignmentCriteriaInput } from "../../criteria/alignmentCriteria.js";
import type { ProfileCriteriaInput } from "../../criteria/profileCriteria.js";
import type { FixOption } from "../../criteria/types/FixOption.js";

// 수정안을 만든 검토. 적용한 뒤 같은 검토를 다시 돌린다. 다시 돌릴 검토가 없으면 "none".
export type FixSource =
  | { check: "alignment"; input: AlignmentCriteriaInput }
  | { check: "profile"; input: ProfileCriteriaInput }
  | { check: "none" };

// data/changes/fixes 에 저장된 수정안.
export type StoredFix = FixOption & {
  id: string;
  applicable: boolean;   // 플러그인이 자동 적용할 수 있는지
  target: string;        // 대상 (예: 곡선 2 (...))
  check: string;         // 조문과 검토 이름 (예: 제19조 최소 평면곡선 반지름)
  createdAt: string;
  requestId: string;     // 수정안을 계산한 팔레트 요청
  source: FixSource;
};
