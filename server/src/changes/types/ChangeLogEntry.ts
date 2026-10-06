// One apply attempt in data/logs/<date>/changes.jsonl. check is the criteria check the fix
// answers (code-made, such as "제19조 최소 평면곡선 반지름"), or "alignment.create".
export type ChangeLogEntry = {
  at: string; requestId: string; fixId: string; state: "applied" | "failed";
  title: string; target: string; labels: string[]; check?: string;
  result?: {
    changes?: { kind: string; at?: number; property: string; before: number; after: number }[];
    created?: { name: string; handle: string; length: number; curves: { ip: number; radius: number; spiralLength?: number }[] };
    revision: string;
  };
  error?: string;
};
