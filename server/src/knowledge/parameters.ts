// 설정값: 승인된 관행 중 코드가 직접 쓰는 값.
// "반지름은 10 m 단위로 올린다" 같은 관행은 AI가 기억하게 두지 않고, 승인되면 설계 코드가 읽는 설정값이 된다.
// 아래 키만 있고, 키마다 허용 값이 정해져 있다.
//
// 우선순위: 이 PC 승인(knowledge/parameters.json, /후보) > 중앙 승인(knowledge/central-parameters.json) > 코드 기본값.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { knowledgeDir } from "./knowledgeStore.js";

// 설정값 목록.
//   label:   사람이 읽는 이름
//   allowed: 허용 값
//   unset:   정하지 않았을 때 코드가 쓰는 값(설명용)
//   observe: 중앙 서버가 사람의 수정 기록에서 이 설정값을 제안할 때 보는 속성
export const PARAMETERS = {
  "alignment.radiusStep": {
    label: "평면곡선 반지름 올림 단위(m)",
    allowed: [1, 5, 10, 50, 100],
    unset: "선형 계획 5 m, 수정안 1 m",
    observe: "alignment.radius"
  },
  "alignment.spiralStep": {
    label: "완화곡선 길이 올림 단위(m)",
    allowed: [1, 5, 10],
    unset: "1 m",
    observe: "alignment.spiralLength"
  },
  "profile.curveLengthStep": {
    label: "종단곡선 길이 올림 단위(m)",
    allowed: [1, 5, 10, 20],
    unset: "1 m",
    observe: "profile.curveLength"
  }
} as const;

export type ParameterKey = keyof typeof PARAMETERS;
export type ParameterValue = { value: number; from: string; at: string };   // from: 승인한 후보 id 또는 "중앙 vN"
type ParameterFile = Partial<Record<ParameterKey, ParameterValue>>;

export const isParameterKey = (key: unknown): key is ParameterKey => typeof key === "string" && key in PARAMETERS;

// { key, value } 가 있는 키이고 허용 값이면 받는다.
export function validParameter(value: unknown): { key: ParameterKey; value: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!isParameterKey(item.key) || typeof item.value !== "number") return undefined;
  const allowed = PARAMETERS[item.key].allowed as readonly number[];
  return allowed.includes(item.value) ? { key: item.key, value: item.value } : undefined;
}

const localFile = () => join(knowledgeDir(), "parameters.json");
export const centralFile = () => join(knowledgeDir(), "central-parameters.json");

// 설정값 파일을 읽는다. 올바르지 않은 항목은 버린다.
async function read(file: string): Promise<ParameterFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const out: ParameterFile = {};
    for (const [key, entry] of Object.entries(parsed)) {
      const stored = entry as ParameterValue;
      const checked = validParameter({ key, value: stored?.value });
      if (checked) out[checked.key] = { value: checked.value, from: String(stored.from ?? ""), at: String(stored.at ?? "") };
    }
    return out;
  } catch {
    return {};
  }
}

// 마지막으로 읽은 두 파일.
let loaded: { local: ParameterFile; central: ParameterFile } = { local: {}, central: {} };

// 두 파일을 읽어 둔다. 설계·검토 입구에서 먼저 부르고, 그 뒤 param()/step()이 이 값을 쓴다.
export async function loadParameters(): Promise<void> {
  const [local, central] = await Promise.all([read(localFile()), read(centralFile())]);
  loaded = { local, central };
}

export type ResolvedParameter = { key: ParameterKey; value: number; source: "이 PC 승인" | "중앙 승인"; from: string };

// 지금 적용되는 설정값(이 PC 승인 > 중앙 승인). 없으면 undefined(코드 기본값).
export function param(key: ParameterKey): ResolvedParameter | undefined {
  const local = loaded.local[key];
  if (local) return { key, value: local.value, source: "이 PC 승인", from: local.from };
  const central = loaded.central[key];
  return central ? { key, value: central.value, source: "중앙 승인", from: central.from } : undefined;
}

// 올림 단위. 승인된 값이면 notes에 출처를 한 줄 남긴다(계획·수정안 메모에 보이게).
export function step(key: ParameterKey, fallback: number, notes?: string[]): number {
  const found = param(key);
  if (!found) return fallback;
  const from = found.from ? ` ${found.from}` : "";
  const note = `${PARAMETERS[key].label} ${found.value}을(를) 썼다(${found.source}${from}).`;
  if (notes && !notes.includes(note)) notes.push(note);
  return found.value;
}

// /후보 승인으로 이 PC의 설정값을 바꾼다.
export async function setLocalParameter(key: ParameterKey, value: number, from: string): Promise<void> {
  const current = await read(localFile());
  current[key] = { value, from, at: new Date().toISOString() };
  await writeAtomic(localFile(), JSON.stringify(current, null, 1));
}

// 중앙에서 받은 설정값으로 파일을 통째로 바꾼다.
export async function writeCentralParameters(values: Record<string, number>, version: number): Promise<void> {
  const out: ParameterFile = {};
  for (const [key, value] of Object.entries(values)) {
    const checked = validParameter({ key, value });
    if (checked) out[checked.key] = { value: checked.value, from: `중앙 v${version}`, at: new Date().toISOString() };
  }
  await writeAtomic(centralFile(), JSON.stringify(out, null, 1));
}

// 지금 적용되는 모든 설정값과 출처(/설정값 표시와 답변 재사용 키에 쓴다).
export async function parameterSummary(): Promise<{ key: ParameterKey; label: string; value: string; source: string }[]> {
  await loadParameters();
  return (Object.keys(PARAMETERS) as ParameterKey[]).map(key => {
    const found = param(key);
    return {
      key,
      label: PARAMETERS[key].label,
      value: found ? String(found.value) : PARAMETERS[key].unset,
      source: found ? `${found.source}${found.from ? ` ${found.from}` : ""}` : "기본값"
    };
  });
}
