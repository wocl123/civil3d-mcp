// 구글 드라이브 연결 설정 (data/settings.json, docs/데이터관리_설계.md §6).
//   사용자 PC: 자기 구글 드라이브에 보내기 폴더를 만들고 기록을 넣는다. 관리자와 공유하면 관리자가 가져간다.
//   관리자 PC(admin): 공유받은 폴더들에서 기록을 가져오고, 승인 지식과 배포본을 각 폴더에 넣어 준다.
// GitHub 릴리스 zip으로 설치하면 team.json(관리자 메일)이 함께 들어와, 따로 설정하지 않아도 사용자 PC로 동작한다.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

export type DriveSettings = {
  enabled: boolean;      // false면 드라이브로 보내기를 멈춤(기록은 계속 쌓인다)
  admin?: boolean;       // 관리자 PC
  root?: string;         // 구글 드라이브 "내 드라이브" 폴더를 직접 정했을 때만(없으면 찾는다)
  adminEmail?: string;   // 보내기 폴더를 공유할 관리자 메일(안내에 쓴다)
  since: string;
};
export type Settings = { schema: 1; drive?: DriveSettings };
export type Team = { adminEmail?: string };

const file = () => join(dataDir(), "settings.json");

export async function loadSettings(): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as Partial<Settings>;
    if (parsed.schema === 1) return { schema: 1, ...(parsed.drive ? { drive: parsed.drive } : {}) };
  } catch {
    // 아직 설정이 없다.
  }
  return { schema: 1 };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeAtomic(file(), JSON.stringify(settings, null, 1));
}

// 설치 프로그램이 남긴 팀 정보(data/team.json: 관리자 메일). GitHub 릴리스 zip에 들어 있다.
export async function loadTeam(): Promise<Team | undefined> {
  try {
    const parsed = JSON.parse((await readFile(join(dataDir(), "team.json"), "utf8")).replace(/^﻿/, "")) as Team;
    return typeof parsed.adminEmail === "string" && validEmail(parsed.adminEmail) ? { adminEmail: parsed.adminEmail } : {};
  } catch {
    return undefined;
  }
}

export const validEmail = (text: string) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(text);

// 지금 쓰는 드라이브 설정. 따로 정한 적이 없어도 팀 정보가 있으면 사용자 PC로 켠다.
export async function driveSettings(): Promise<DriveSettings | undefined> {
  const settings = await loadSettings();
  const team = await loadTeam();
  if (settings.drive) return { ...settings.drive, adminEmail: settings.drive.adminEmail ?? team?.adminEmail };
  return team ? { enabled: true, adminEmail: team.adminEmail, since: "" } : undefined;
}
