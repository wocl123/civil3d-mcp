// 구글 드라이브(Google Drive for Desktop) 폴더 찾기와 보내기 폴더 모양.
// 서버 없이 드라이브 공유로 사용자 → 관리자 데이터를 옮긴다(docs/데이터관리_설계.md §6).
//
// 사용자 PC는 자기 "내 드라이브"에 보내기 폴더를 만든다. 사용자가 이 폴더를 관리자와 "편집자"로 공유하면(= 가입 신청),
// 관리자는 받은 공유를 "내 드라이브에 바로가기 추가"한다(= 승인). 그러면 관리자 PC에도 같은 폴더가 동기화된다.
//   MyCivil3DMcp-<설치 ID>/
//     member.json            이 폴더가 어느 설치의 것인지(설치 ID)
//     packages/<id>.json     보낼 묶음(비식별) ← 사용자
//     candidates/<id>.json   지식 후보(비식별)  ← 사용자
//     admin/received.json    관리자가 가져간 묶음·후보 id (사용자 PC가 보고 지운다) ← 관리자
//     admin/official.json    승인 지식과 설정값 ← 관리자
//     admin/release.json + MyCivil3DMcp-<버전>-win-x64.zip   배포 버전 ← 관리자
// 이름은 영문으로만 둔다(드라이브 동기화와 인코딩 문제를 피한다).

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomic } from "../files.js";

export const MEMBER_FILE = "member.json";
export const memberFolderName = (installId: string) => `MyCivil3DMcp-${installId}`;
export type MemberFolder = { path: string; name: string; installId: string };

// "내 드라이브" 폴더. 정한 경로(설정·테스트용 MY_CIVIL3D_DRIVE_DIR)가 있으면 그것, 없으면 흔한 위치를 찾는다:
// 스트리밍(드라이브 문자 G: 등)의 "내 드라이브"/"My Drive", 미러링(사용자 폴더 아래).
export function findDriveRoot(configured?: string): string | undefined {
  const fixed = process.env.MY_CIVIL3D_DRIVE_DIR ?? configured;
  if (fixed) return existsSync(fixed) ? fixed : undefined;
  const names = ["내 드라이브", "My Drive"];
  const letters = "GHIJKLMNOPQRSTUVWXYZDEF".split("");
  for (const letter of letters) for (const name of names) {
    const path = `${letter}:\\${name}`;
    if (existsSync(path)) return path;
  }
  for (const name of names) for (const base of [homedir(), join(homedir(), "Google Drive")]) {
    const path = join(base, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

// 사용자 PC: 보내기 폴더를 만든다(이미 있으면 그대로).
export async function ensureMemberFolder(root: string, installId: string): Promise<string> {
  const folder = join(root, memberFolderName(installId));
  if (!existsSync(join(folder, MEMBER_FILE))) {
    await mkdir(join(folder, "packages"), { recursive: true });
    await mkdir(join(folder, "candidates"), { recursive: true });
    await writeAtomic(join(folder, MEMBER_FILE), JSON.stringify({ schema: 1, app: "my-civil3d-mcp", installId, createdAt: new Date().toISOString() }, null, 1));
  }
  return folder;
}

async function readMember(path: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse((await readFile(join(path, MEMBER_FILE), "utf8")).replace(/^﻿/, "")) as { app?: unknown; installId?: unknown };
    return parsed.app === "my-civil3d-mcp" && typeof parsed.installId === "string" && /^[a-f\d]{16}$/.test(parsed.installId) ? parsed.installId : undefined;
  } catch {
    return undefined;
  }
}

// 관리자 PC: 내 드라이브 바로 아래와 한 단계 아래(정리용 폴더 안)에서 보내기 폴더를 찾는다.
export async function findMemberFolders(root: string): Promise<MemberFolder[]> {
  const found: MemberFolder[] = [];
  const children = async (path: string) => (await readdir(path, { withFileTypes: true }).catch(() => []))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."));
  for (const entry of await children(root)) {
    const path = join(root, entry.name);
    const installId = await readMember(path);
    if (installId) { found.push({ path, name: entry.name, installId }); continue; }
    for (const inner of await children(path)) {
      const innerPath = join(path, inner.name);
      const innerId = await readMember(innerPath);
      if (innerId) found.push({ path: innerPath, name: `${entry.name}\\${inner.name}`, installId: innerId });
    }
  }
  return found;
}

// 폴더 안 JSON 파일 이름들(없으면 빈 목록).
export const jsonFiles = async (folder: string) => (await readdir(folder).catch(() => [] as string[])).filter(name => name.endsWith(".json")).sort();
