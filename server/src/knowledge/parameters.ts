import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { knowledgeDir } from "./knowledgeStore.js";

// Approved practices that code uses directly. A practice such as "반지름은 10 m 단위로
// 올린다" is not left to the AI to remember: once approved, it becomes a setting the
// design code reads. Only the keys below exist, each with the values it may take.
// This PC's approvals (knowledge/parameters.json, from /후보) come before the central
// server's (knowledge/central-parameters.json), which come before the code's defaults.
export const PARAMETERS = {
  "alignment.radiusStep": {
    label: "평면곡선 반지름 올림 단위(m)", allowed: [1, 5, 10, 50, 100],
    unset: "선형 계획 5 m, 수정안 1 m", observe: "alignment.radius"
  },
  "alignment.spiralStep": {
    label: "완화곡선 길이 올림 단위(m)", allowed: [1, 5, 10], unset: "1 m", observe: "alignment.spiralLength"
  },
  "profile.curveLengthStep": {
    label: "종단곡선 길이 올림 단위(m)", allowed: [1, 5, 10, 20], unset: "1 m", observe: "profile.curveLength"
  }
} as const;

export type ParameterKey = keyof typeof PARAMETERS;
export type ParameterValue = { value: number; from: string; at: string };
type ParameterFile = Partial<Record<ParameterKey, ParameterValue>>;

export const isParameterKey = (key: unknown): key is ParameterKey => typeof key === "string" && key in PARAMETERS;

export function validParameter(value: unknown): { key: ParameterKey; value: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  if (!isParameterKey(item.key) || typeof item.value !== "number") return undefined;
  return (PARAMETERS[item.key].allowed as readonly number[]).includes(item.value) ? { key: item.key, value: item.value } : undefined;
}

const localFile = () => join(knowledgeDir(), "parameters.json");
export const centralFile = () => join(knowledgeDir(), "central-parameters.json");

async function read(file: string): Promise<ParameterFile> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    const out: ParameterFile = {};
    for (const [key, entry] of Object.entries(parsed)) {
      const checked = validParameter({ key, value: (entry as ParameterValue)?.value });
      if (checked) out[checked.key] = { value: checked.value, from: String((entry as ParameterValue).from ?? ""), at: String((entry as ParameterValue).at ?? "") };
    }
    return out;
  } catch { return {}; }
}

let loaded: { local: ParameterFile; central: ParameterFile } = { local: {}, central: {} };

// Reads both files. Each design or check entry point calls this first; param() then reads the result.
export async function loadParameters(): Promise<void> {
  const [local, central] = await Promise.all([read(localFile()), read(centralFile())]);
  loaded = { local, central };
}

export type ResolvedParameter = { key: ParameterKey; value: number; source: "이 PC 승인" | "중앙 승인"; from: string };

export function param(key: ParameterKey): ResolvedParameter | undefined {
  const local = loaded.local[key];
  if (local) return { key, value: local.value, source: "이 PC 승인", from: local.from };
  const central = loaded.central[key];
  return central ? { key, value: central.value, source: "중앙 승인", from: central.from } : undefined;
}

// The step to round to, and a note when it came from an approval rather than the code.
export function step(key: ParameterKey, fallback: number, notes?: string[]): number {
  const found = param(key);
  if (!found) return fallback;
  const note = `${PARAMETERS[key].label} ${found.value}을(를) 썼다(${found.source}${found.from ? ` ${found.from}` : ""}).`;
  if (notes && !notes.includes(note)) notes.push(note);
  return found.value;
}

export async function setLocalParameter(key: ParameterKey, value: number, from: string): Promise<void> {
  const current = await read(localFile());
  current[key] = { value, from, at: new Date().toISOString() };
  await writeAtomic(localFile(), JSON.stringify(current, null, 1));
}

export async function writeCentralParameters(values: Record<string, number>, version: number): Promise<void> {
  const out: ParameterFile = {};
  for (const [key, value] of Object.entries(values)) {
    const checked = validParameter({ key, value });
    if (checked) out[checked.key] = { value: checked.value, from: `중앙 v${version}`, at: new Date().toISOString() };
  }
  await writeAtomic(centralFile(), JSON.stringify(out, null, 1));
}

// Every setting in force, for /설정값 and for the answer-reuse key.
export async function parameterSummary(): Promise<{ key: ParameterKey; label: string; value: string; source: string }[]> {
  await loadParameters();
  return (Object.keys(PARAMETERS) as ParameterKey[]).map(key => {
    const found = param(key);
    return { key, label: PARAMETERS[key].label, value: found ? String(found.value) : PARAMETERS[key].unset,
      source: found ? `${found.source}${found.from ? ` ${found.from}` : ""}` : "기본값" };
  });
}
