// 중앙 서버 HTTPS 인증서 (<dataDir>/tls, new-cert.ps1 이 만든다).
// 클라이언트(설치 프로그램, 각 PC의 서비스)는 공용 인증기관 대신 이 인증서의 지문(SHA-256)을 고정해 믿는다.

import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./config.js";

export type Tls = { pfx: Buffer; passphrase: string; fingerprint: string };

// 지문은 콜론 없는 소문자 16진수 64자로 통일한다(server.json, settings.json, 설치 프로그램이 같은 모양을 쓴다).
export const normalizeFingerprint = (text: string) => text.replace(/[:\s]/g, "").toLowerCase();

export function loadTls(): Tls | undefined {
  const folder = join(dataDir, "tls");
  const pfx = join(folder, "server.pfx");
  if (!existsSync(pfx)) return undefined;
  const certificate = new X509Certificate(readFileSync(join(folder, "server.cer")));
  return {
    pfx: readFileSync(pfx),
    passphrase: readFileSync(join(folder, "server.pass"), "utf8").trim(),
    fingerprint: normalizeFingerprint(certificate.fingerprint256)
  };
}

// 이 PC 안에서만 쓰는 주소인지(HTTP를 허용하는 유일한 경우).
export const loopbackHost = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";
