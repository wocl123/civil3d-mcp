// 중앙 서버 연결 설정 (data/settings.json).
//   token:       등록할 때 받은 이 설치의 인증 토큰 (가입키 자체는 저장하지 않는다)
//   reviewerKey: 검토자 PC에만 있다
// 둘 다 로그에 쓰거나 서버 말고 다른 곳으로 보내지 않는다.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../files.js";
import { dataDir } from "../paths.js";

export type CentralSettings = {
  url: string;
  token: string;
  certSha256?: string;   // HTTPS 서버 인증서 지문(이것만 믿는다). http(이 PC 안)이면 없다
  enabled: boolean;      // false면 보내기를 멈춤(기록은 계속 쌓인다)
  reviewerKey?: string;
  enrolledAt: string;
};
export type Settings = { schema: 1; central?: CentralSettings };

const file = () => join(dataDir(), "settings.json");

export async function loadSettings(): Promise<Settings> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as Partial<Settings>;
    if (parsed.schema === 1) return parsed as Settings;
  } catch {
    // 아직 설정이 없다.
  }
  return { schema: 1 };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeAtomic(file(), JSON.stringify(settings, null, 1));
}

// 받아들이는 중앙 서버 주소: http(s), 호스트가 있고, 계정·쿼리·# 이 없는 것. 끝의 / 는 뗀다.
export function centralUrl(text: string): string | undefined {
  try {
    const url = new URL(text);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

// 이 PC나 사설망이면 http도 괜찮다. 그 밖이면 토큰이 암호화 없이 인터넷을 지나므로 경고한다.
export function insecureUrl(text: string): boolean {
  const url = new URL(text);
  if (url.protocol === "https:") return false;
  return !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/.test(url.hostname);
}
