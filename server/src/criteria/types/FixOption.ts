import type { DesignChange } from "./DesignChange.js";
import type { AlignmentCreateRequest } from "../../design/types/AlignmentLayout.js";

// 미달 항목을 기준 안으로 들이는 방법 하나. 코드가 계산한다.
//   feasible:   인접 요소 사이에 들어맞음
//   conflict:   들어맞지 않음(reason에 이유)
//   unverified: 다른 요소도 바뀌는데 코드가 다시 검토하지 않음
export type FixOption = {
  // 저장될 때 채워진다: AI가 apply_drawing_change 에 넘기는 id, 플러그인이 자동 적용할 수 있는지.
  id?: string;
  applicable?: boolean;

  title: string;
  changes: DesignChange[];

  // 기존 객체를 바꾸는 대신 새 객체를 만드는 수정안(선형 계획)이면 changes 대신 이것.
  create?: AlignmentCreateRequest;

  status: "feasible" | "conflict" | "unverified";
  reason?: string;
  effects: string[];   // 바꾸면 함께 달라지는 것들 (접선장, 곡선 길이 등)
};
