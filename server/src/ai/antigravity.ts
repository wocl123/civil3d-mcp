// Antigravity의 단일 JSON과 NDJSON 마지막 result를 같은 형태로 읽는다.
export type AntigravityResult = { status?: string; response?: string; error?: unknown; usage?: unknown };

export function antigravityResult(stdout: string): AntigravityResult {
  try {
    const value = JSON.parse(stdout);
    return value.event === "result" ? value.result : value;
  } catch {
    for (const line of stdout.trim().split(/\r?\n/).reverse()) {
      try {
        const value = JSON.parse(line);
        if (value.event === "result" && value.result && typeof value.result === "object") {
          return value.result;
        }
      } catch { /* Ignore diagnostics outside the JSON stream. */ }
    }
  }

  throw new Error("Gemini(Antigravity) returned no terminal result.");
}
