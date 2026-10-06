// 서버가 받는 것 (docs/데이터관리_설계.md §3).
// 설치는 이미 허용한 항목만 보낸다. 서버는 한 번 더 검사하고, 아는 항목만 남기며,
// 글에 경로·파일 이름·메일 주소가 남아 있는 묶음이나 후보는 받지 않는다.

import { validParameter } from "./parameters.js";

// [찾는 모양, 이유] (설치 쪽 server/src/sync/privacy.ts 와 같은 규칙)
const PATTERNS: [RegExp, string][] = [
  [/[A-Za-z]:[\\/]/, "드라이브 경로"],
  [/\\\\[\w.-]+\\/, "네트워크 경로"],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "메일 주소"],
  [/[^\s"'\\/]+\.(dwg|dxf|dwt|rvt|pdf|xlsx?)\b/i, "파일 이름"]
];

// 받으면 안 되는 이유. 괜찮으면 undefined.
export function leak(text: string): string | undefined {
  return PATTERNS.find(([pattern]) => pattern.test(text))?.[1];
}

// 받을 수 없는 입력(→ 422).
export class Invalid extends Error {}

type Obj = Record<string, unknown>;

// ── 값 거르개: 모양이 맞을 때만 값을 받고, 아니면 undefined(빠짐).
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const str = (value: unknown, pattern: RegExp) => typeof value === "string" && pattern.test(value) ? value : undefined;
const WORD = /^[\w.-]{1,40}$/;                               // 짧은 영문 낱말
const NAME = /^[a-z][a-z_]{0,60}$/;                          // 도구 이름
const CHECK = /^[\p{L}\p{N} ·(),.%/①-⑳_-]{1,80}$/u;           // 코드가 만든 검토 이름
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;                     // 시각(시간 단위)
const clean = (record: Obj): Obj => Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
const oneOf = <T>(list: readonly T[], value: unknown) => list.includes(value as T) ? value as T : undefined;

// 기록 하나를 종류별로 아는 항목만 골라 다시 만든다. 모르는 종류면 버린다.
function record(value: unknown): Obj | undefined {
  const item = obj(value);
  const at = str(item.at, HOUR);
  if (!at) return undefined;

  switch (item.type) {
    // 질문 1건
    case "turn": {
      const usage = obj(item.usage);
      const counts = obj(item.counts);
      return clean({
        type: "turn",
        at,
        kind: str(item.kind, WORD),
        provider: str(item.provider, WORD),
        model: str(item.model, WORD),
        effort: str(item.effort, WORD),
        ms: num(item.ms),
        cached: item.cached === true,
        tools: Array.isArray(item.tools) ? item.tools.filter(tool => str(tool, NAME)).slice(0, 50) : [],
        usage: clean({
          inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), cachedInputTokens: num(usage.cachedInputTokens)
        }),
        counts: clean({
          recorded: num(counts.recorded), candidates: num(counts.candidates), fixes: num(counts.fixes), applied: num(counts.applied)
        }),
        errorKind: str(item.errorKind, WORD)
      });
    }

    // 도구 호출 1건
    case "tool":
      return clean({
        type: "tool",
        at,
        tool: str(item.tool, NAME),
        ms: num(item.ms),
        ok: item.ok === true,
        outputChars: num(item.outputChars),
        images: num(item.images),
        errorKind: str(item.errorKind, WORD)
      });

    // 도면 변경 시도 1건
    case "change":
      return clean({
        type: "change",
        at,
        state: oneOf(["applied", "failed"], item.state),
        source: oneOf(["create", "fix"], item.source),
        check: str(item.check, CHECK),
        changes: Array.isArray(item.changes)
          ? item.changes.slice(0, 50).map(change => clean({
            kind: str(obj(change).kind, WORD),
            property: str(obj(change).property, WORD),
            before: num(obj(change).before),
            after: num(obj(change).after)
          }))
          : [],
        curves: num(item.curves),
        errorKind: str(item.errorKind, WORD)
      });

    // 수정 추적 결과 1건
    case "modification": {
      const conditions = obj(item.conditions);
      const outcome = oneOf(["modified", "kept", "deleted", "restructured"], item.outcome);
      const property = oneOf(["radius", "spiralLength", "elevation", "curveLength"], item.property);
      if (!outcome || !property) return undefined;
      return clean({
        type: "modification",
        at,
        outcome,
        source: oneOf(["create", "fix"], item.source),
        check: str(item.check, CHECK),
        objectKind: oneOf(["alignment", "profile"], item.objectKind),
        property,
        aiValue: num(item.aiValue),
        userValue: num(item.userValue),
        ageHours: num(item.ageHours),
        conditions: clean({
          designSpeed: num(conditions.designSpeed),
          roadClass: str(conditions.roadClass, /^[\p{L}()·\s]{1,30}$/u),
          region: str(conditions.region, /^[\p{L}()·\s]{1,30}$/u),
          criteria: str(conditions.criteria, /^[\w가-힣.-]{1,60}$/)
        })
      });
    }

    default:
      return undefined;
  }
}

// 묶음 하나를 검사한다: 형식, 보낸 설치와 묶음의 설치가 같은지, 기록 수, 마지막 검사.
export function validPackage(body: unknown, installId: string): { packageId: string; records: Obj[] } {
  const item = obj(body);
  const packageId = str(item.packageId, /^[a-f\d]{16}-[\w-]{1,40}$/);
  if (item.schema !== 1 || !packageId || item.installId !== installId) throw new Invalid("패키지 형식이 맞지 않습니다.");
  if (!packageId.startsWith(installId)) throw new Invalid("다른 설치의 패키지입니다.");
  if (!Array.isArray(item.records) || item.records.length > 1000) throw new Invalid("records가 없거나 너무 많습니다.");

  const records = item.records.map(record).filter((value): value is Obj => !!value);
  const reason = leak(JSON.stringify(records));
  if (reason) throw new Invalid(`비식별 검사에 걸렸습니다(${reason}).`);
  return { packageId, records };
}

export type CandidateIn = {
  localId: string;
  title: string;
  content: string;
  parameter?: { key: string; value: number };
  provider?: string;
  at?: string;
  localStatus?: string;
};

// 후보 목록을 검사한다(한 번에 50개까지). 하나라도 형식이 틀리거나 검사에 걸리면 전부 받지 않는다.
export function validCandidates(body: unknown): CandidateIn[] {
  const list = obj(body).candidates;
  if (!Array.isArray(list) || list.length > 50) throw new Invalid("candidates가 없거나 너무 많습니다.");

  return list.map(value => {
    const item = obj(value);
    const localId = str(item.localId, /^C-\d{8}-\d{1,4}$/);
    const title = typeof item.title === "string" ? item.title.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    const content = typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    if (!localId || !content) throw new Invalid("후보 형식이 맞지 않습니다.");

    const reason = leak(title + " " + content);
    if (reason) throw new Invalid(`비식별 검사에 걸렸습니다(${reason}).`);

    const parameter = validParameter(item.parameter);
    return {
      localId,
      title,
      content,
      ...(parameter ? { parameter } : {}),
      provider: str(item.provider, WORD),
      at: str(item.at, /^\d{4}-\d{2}-\d{2}$/),
      localStatus: oneOf(["pending", "approved"], item.localStatus)
    };
  });
}
