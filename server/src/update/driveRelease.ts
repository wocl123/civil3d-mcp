// Public Drive release channel. One signed JSON file is independent of member registration.
import { verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { RELEASE_PUBLIC_KEY } from "../admin/releaseKey.js";
import { downloadUrl } from "../drive/driveFolders.js";

export type DriveRelease = {
  schema: 1; version: string; file: string; size: number; sha256: string;
  downloadId: string; signature: string; publishedAt: string; minVersion?: string;
};
export async function trustedReleaseKey(): Promise<string> {
  return process.env.MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE
    ? readFile(process.env.MY_CIVIL3D_RELEASE_PUBLIC_KEY_FILE, "utf8") : RELEASE_PUBLIC_KEY;
}

export function validDriveRelease(value: unknown): DriveRelease {
  const r = value as Partial<DriveRelease> | undefined;
  if (!r || r.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(r.version ?? "")
      || r.file !== `MyCivil3DMcp-${r.version}-win-x64.exe`
      || !Number.isSafeInteger(r.size) || r.size! <= 0 || r.size! > 1024 * 1024 * 1024
      || !/^[a-f\d]{64}$/.test(r.sha256 ?? "") || !/^[\w-]{10,200}$/.test(r.downloadId ?? "")
      || typeof r.signature !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(r.signature)
      || !Number.isFinite(Date.parse(r.publishedAt ?? ""))
      || (r.minVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(r.minVersion))) {
    throw new Error("Drive 배포 정보 형식이 맞지 않습니다.");
  }

  if (r.minVersion && compare(r.minVersion, r.version!) > 0) {
    throw new Error("최소 버전이 배포 버전보다 높습니다.");
  }

  return r as DriveRelease;
}

function compare(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }

  return 0;
}

export async function readDriveRelease(id: string): Promise<DriveRelease> {
  const envelope = JSON.parse((await downloadDriveFile(id, 64 * 1024)).toString("utf8").replace(/^\uFEFF/, ""));
  if (envelope.schema !== 1 || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
    throw new Error("서명된 Drive 배포 정보가 아닙니다.");
  }

  const bytes = Buffer.from(envelope.payload, "base64");
  if (!verify("sha256", bytes, await trustedReleaseKey(), Buffer.from(envelope.signature, "base64"))) {
    throw new Error("Drive 배포 정보 서명이 맞지 않습니다.");
  }

  return validDriveRelease(JSON.parse(bytes.toString("utf8")));
}

export async function downloadDriveFile(id: string, maxBytes: number): Promise<Buffer> {
  if (!/^[\w-]{10,200}$/.test(id)) {
    throw new Error("Drive 파일 ID가 맞지 않습니다.");
  }

  const response = await fetch(downloadUrl(id), { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok || !response.body) {
    throw new Error(`Drive 다운로드 실패(HTTP ${response.status})`);
  }

  const advertised = Number(response.headers.get("content-length"));
  if (advertised > maxBytes) {
    await response.body.cancel();
    throw new Error("Drive 파일 크기 제한 초과");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("Drive 파일 크기 제한 초과");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, size);
}
