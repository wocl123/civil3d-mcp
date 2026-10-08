// 관리자 PC의 기준값 (data/admin/config.json). 처음 쓸 때 기본값으로 만든다.
// 통계 기준은 여러 사용자의 패턴을 언제 제안으로 올릴지 정한다(review.ts).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.js";

export type AdminConfig = {
  schema: 1;
  minInstalls: number;   // 설정값 제안에 필요한 서로 다른 설치 수
  minCases: number;      // 설정값 제안에 필요한 수정 건수
  minShare: number;      // 해당 수정 중 같은 방향인 비율
  reportDays: number;    // /검토 보고 기간(일)
  githubRepo: string;    // 배포본을 받을 GitHub 저장소 "owner/repo" (/중앙 배포, gh CLI)
  downloadId?: string;   // 공용 배포 파일(MyCivil3DMcp-release/…latest….zip)의 구글 드라이브 파일 ID(/중앙 배포 링크). 링크 공유: 보기
};

const DEFAULTS: AdminConfig = { schema: 1, minInstalls: 2, minCases: 5, minShare: 0.8, reportDays: 30, githubRepo: "wocl123/civil3d-mcp" };

export const adminDir = () => join(dataDir(), "admin");

export function loadAdminConfig(): AdminConfig {
  mkdirSync(adminDir(), { recursive: true });
  const file = join(adminDir(), "config.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as Partial<AdminConfig>;
    if (parsed.schema === 1) return { ...DEFAULTS, ...parsed };
  } catch {
    // 아래에서 만든다.
  }
  writeFileSync(file, JSON.stringify(DEFAULTS, null, 1), "utf8");
  return { ...DEFAULTS };
}

export function saveAdminConfig(config: AdminConfig): void {
  mkdirSync(adminDir(), { recursive: true });
  writeFileSync(join(adminDir(), "config.json"), JSON.stringify(config, null, 1), "utf8");
}

// 구글 드라이브 공유 링크(또는 파일 ID)에서 파일 ID를 꺼낸다.
//   https://drive.google.com/file/d/<ID>/view?usp=sharing, …?id=<ID>, 또는 ID 그대로
export function driveFileId(text: string): string | undefined {
  const id = /\/d\/([\w-]+)/.exec(text)?.[1] ?? /[?&]id=([\w-]+)/.exec(text)?.[1] ?? text.trim();
  return /^[\w-]{10,200}$/.test(id) ? id : undefined;
}
