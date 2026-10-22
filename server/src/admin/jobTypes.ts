export type AdminJob = { kind: "summary" | "todoCount" | "sync" } | { kind: "command"; text: string };

export const longAdminJob = (job: AdminJob): boolean => job.kind === "sync" || (job.kind === "command" &&
  (/^\/검토 사례 \d+ (완료|버림)(\s|$)/.test(job.text) || ["/검토 드라이브정리", "/검토 정리"].includes(job.text)));
