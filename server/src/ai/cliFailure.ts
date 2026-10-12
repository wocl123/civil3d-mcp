import type { Provider } from "./types/Provider.js";
import type { CliResult } from "./types/CliResult.js";
import type { QuotaInfo } from "./types/QuotaInfo.js";
import type { QuotaWindow } from "./types/QuotaWindow.js";

export type CliFailure = {
  kind: "limit" | "auth" | "billing" | "network" | "execution";
  detail: string; exhausted: boolean; resetsAt: string[]; resetHint?: string; window?: string;
};
const names = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
const record = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const iso = (v: unknown): string | undefined => {
  const time = typeof v === "number" ? v * (v < 1e12 ? 1000 : 1) : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(time) && time > 0 && time < 8.64e15 ? new Date(time).toISOString() : undefined;
};

const label = (type: unknown) => type === "five_hour" ? "5시간" : type === "seven_day" ? "7일"
  : type === "seven_day_sonnet" ? "Sonnet 7일" : type === "seven_day_opus" ? "Opus 7일" : "사용 한도";

// Only error envelopes are inspected. Normal answers/tool results mentioning quotas are not errors.
export function parseCliFailure(provider: Provider, result: CliResult, now = Date.now()): CliFailure | undefined {
  let events: Record<string, any>[] = [];
  try {
    events = [record(JSON.parse(result.stdout))];
  } catch {
    for (const line of result.stdout.split(/\r?\n/)) {
      try {
        events.push(record(JSON.parse(line)));
      } catch {}
    }
  }

  const lastResult = events.filter(e => e.type === "result").at(-1);
  const lastTurn = events.filter(e => e.type === "turn.failed" || e.type === "turn.completed").at(-1);
  const gemini = provider === "gemini" ? events.find(e => !e.type) : undefined;
  const failed = result.code !== 0 || lastResult?.is_error === true || !!gemini?.error
    || (provider === "claude" && !lastResult && events.some(e => e.type === "assistant" && e.error))
    || lastTurn?.type === "turn.failed"
    || (provider === "codex" && !lastTurn && events.some(e => e.type === "error"));
  if (!failed) {
    return undefined;
  }

  const parts: string[] = [result.stderr.trim()];
  const resetsAt: string[] = [];
  let denied = false, window: string | undefined;
  const inspect = (value: unknown, depth = 0): void => {
    if (depth > 6 || value == null) {
      return;
    }

    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) {
        inspect(item, depth + 1);
      }

      return;
    }

    const item = record(value);
    for (const key of ["message", "code", "type", "error", "errors", "codexErrorInfo", "status", "statusCode", "details", "reason", "result", "subtype"]) {
      if (item[key] !== undefined) {
        inspect(item[key], depth + 1);
      }
    }

    for (const key of ["resetsAt", "resets_at", "reset_at", "resetAt"]) {
      const time = iso(item[key]);
      if (time) {
        resetsAt.push(time);
      }
    }

    // RetryInfo is an explicit provider retry interval, not a locally invented reset.
    const delay = typeof item.retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(item.retryDelay)?.[1] : undefined;
    if (delay) {
      resetsAt.push(new Date(now + Number(delay) * 1000).toISOString());
    }

    if (typeof item.retryAfter === "number" && item.retryAfter > 0) {
      resetsAt.push(new Date(now + item.retryAfter * 1000).toISOString());
    }
  };

  for (const event of events) {
    if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") {
      denied = true;
      window = label(event.rate_limit_info.rateLimitType);
      const time = iso(event.rate_limit_info.resetsAt);
      if (time) {
        resetsAt.push(time);
      }
    } else if (event.type === "result" && event.is_error === true) {
      inspect(event);
    } else if (event.type === "assistant" && event.error) {
      inspect(event.error);
      for (const part of event.message?.content ?? []) {
        if (part.type === "text") {
          inspect(part.text);
        }
      }
    } else if (event.type === "error" || event.type === "turn.failed") {
      inspect(event);
    } else if (provider === "gemini" && !event.type && event.error) {
      inspect(event.error);
    }
  }

  if (!events.length) {
    parts.push(result.stdout.trim());
  }

  const detail = parts.filter(Boolean).join(" ").slice(0, 8000);
  const kind: CliFailure["kind"] =
    /authentication[_ -]?(?:failed|error)|unauthenticated|unauthorized|not logged in|login required|please (?:run \/login|log[ -]?in)|(?:access |oauth )?token (?:has )?expired|invalid[_ -]?api[_ -]?key|(?:invalid|expired) (?:access |oauth )?(?:token|credentials)|\b401\b/i.test(detail) ? "auth"
    : /insufficient_quota|billing[_ -]?error|insufficient credits|credit balance|payment required|credits_required|\b402\b/i.test(detail) ? "billing"
    : denied || /usage[_ -]?limit|rate[_ -]?limit|quota(?:[_ -]?(?:exceeded|error))?|resource[_ -]?exhausted|too many requests|hit (?:your |the )?limit|\b429\b/i.test(detail) ? "limit"
    : /ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network error|fetch failed|overloaded|server[_ -]?error|\b50[234]\b/i.test(detail) ? "network" : "execution";
  const resetHint = /\b(?:resets?|try again (?:at|in)|retry (?:after|in))\b[^\r\n]{1,120}/i.exec(detail)?.[0];
  return { kind, detail, exhausted: denied || /usage[_ -]?limit|hit (?:your |the )?limit|quota[_ -]?exceeded/i.test(detail),
    resetsAt: [...new Set(resetsAt)], ...(resetHint ? { resetHint } : {}), ...(window ? { window } : {}) };
}

export function resetText(value: string, now = Date.now()): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= now) {
    return "재설정 시각이 지났습니다. 한도를 다시 확인해 주세요.";
  }

  const minutes = Math.max(1, Math.ceil((time - now) / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  const wait = [days ? days + "일" : "", hours ? hours + "시간" : "", mins ? mins + "분" : ""].filter(Boolean).join(" ");
  const date = new Date(time).toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  return date + " (약 " + wait + " 후)";
}

export function formatCliFailure(provider: Provider, failure: CliFailure, quota?: QuotaInfo, now = Date.now()): string {
  const name = names[provider];
  if (failure.kind === "auth") {
    return name + " 로그인이 만료됐거나 인증에 실패했습니다. 팔레트에서 이 AI를 다시 선택해 로그인해 주세요.";
  }

  if (failure.kind === "billing") {
    return name + " 계정의 결제 또는 추가 크레딧 문제로 요청을 처리하지 못했습니다. 해당 AI 계정의 결제·크레딧 상태를 확인해 주세요.";
  }

  if (failure.kind === "network") {
    return name + " 연결 또는 서버 문제로 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (failure.kind !== "limit") {
    return name + " 실행에 실패했습니다. " + (failure.detail ? failure.detail.slice(0, 400) : "CLI 오류 정보를 받지 못했습니다. 프로그램과 CLI 설정을 확인해 주세요.");
  }

  const exhausted = (quota?.status === "available" ? quota.windows : []).filter(w => w.remainingPercent <= 0
    && (!w.resetsAt || Date.parse(w.resetsAt) > now));
  const dates = [...failure.resetsAt, ...exhausted.flatMap(w => w.resetsAt ? [w.resetsAt] : [])].filter(d => Date.parse(d) > now);
  const zero = failure.exhausted || exhausted.length > 0;
  const lines = [name + (zero ? " 사용 한도를 모두 사용했습니다(남은 한도 0%)." : " 요청 한도에 도달했습니다.")];
  for (const w of exhausted) {
    lines.push(w.label + ": 남은 한도 0% · " + (w.resetsAt ? "복구 예정 " + resetText(w.resetsAt, now) : "복구 시각 확인 불가"));
  }

  if (dates.length) {
    const last = dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    lines.push("복구 예정: " + resetText(last, now) + (exhausted.some(w => !w.resetsAt) ? " · 일부 한도의 복구 시각은 확인할 수 없습니다." : ""));
  } else if (failure.resetHint) {
    lines.push("제공자 복구 안내: " + failure.resetHint);
  } else {
    lines.push("제공자가 복구 시각을 알려주지 않아 확인할 수 없습니다.");
  }

  lines.push("한도가 복구된 뒤 다시 시도하거나 다른 AI를 선택해 주세요.");
  return lines.join("\n");
}

// Preserve provider rejection evidence for the footer. It never blocks a new request.
// A successful request, the reported reset, or a short expiry removes this evidence.
const rejected = new Map<Provider, { until: number; quota: QuotaInfo }>();
export function rememberLimit(provider: Provider, failure: CliFailure, message: string, quota?: QuotaInfo, now = Date.now()): void {
  if (failure.kind !== "limit") {
    return;
  }

  const known = [...failure.resetsAt, ...(quota?.windows.filter(w => w.remainingPercent <= 0).flatMap(w => w.resetsAt ? [w.resetsAt] : []) ?? [])]
    .filter(d => Date.parse(d) > now).sort((a, b) => Date.parse(b) - Date.parse(a));
  const reset = known[0] ?? null;
  let windows: QuotaWindow[] = quota?.status === "available" ? quota.windows : [];
  if (!windows.length && failure.exhausted) {
    windows = [{ label: failure.window ?? "사용 한도", usedPercent: 100, remainingPercent: 0, resetsAt: reset }];
  }

  rejected.set(provider, { until: Math.min(now + (reset ? 15 : 1) * 60000, reset ? Date.parse(reset) : Infinity),
    quota: { status: windows.length ? "available" : "unavailable", windows, ordinaryUsageAllowed: false, message,
      limit: { resetsAt: reset, message } } });
}

export function observedQuota(provider: Provider, now = Date.now()): QuotaInfo | undefined {
  const entry = rejected.get(provider);
  if (entry && entry.until > now) {
    return entry.quota;
  }

  rejected.delete(provider);
  return undefined;
}

export const clearLimit = (provider: Provider): void => {
  rejected.delete(provider);
};
