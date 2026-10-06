// 도면 변경 시도 하나의 기록 (data/logs/<날짜>/changes.jsonl).
export type ChangeLogEntry = {
  at: string;
  requestId: string;
  fixId: string;
  state: "applied" | "failed";
  title: string;
  target: string;
  labels: string[];   // 사람이 읽는 변경 내용 (describe.ts)
  check?: string;     // 수정안이 답하는 검토 (코드가 만든 이름, 예: "제19조 최소 평면곡선 반지름")

  // 적용 결과: 바뀐 값들(before → after) 또는 새로 만든 선형, 그리고 적용 후 도면 리비전.
  result?: {
    changes?: { kind: string; at?: number; property: string; before: number; after: number }[];
    created?: { name: string; handle: string; length: number; curves: { ip: number; radius: number; spiralLength?: number }[] };
    revision: string;
  };

  error?: string;
};
