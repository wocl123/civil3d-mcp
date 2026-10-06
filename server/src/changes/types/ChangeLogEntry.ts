// One apply attempt in data/changes/log.jsonl.
export type ChangeLogEntry = {
  at: string; requestId: string; fixId: string; state: "applied" | "failed";
  title: string; target: string; labels: string[];
  result?: {
    changes?: { kind: string; at?: number; property: string; before: number; after: number }[];
    created?: { name: string; handle: string; length: number; curves: { ip: number; radius: number; spiralLength?: number }[] };
    revision: string;
  };
  error?: string;
};
