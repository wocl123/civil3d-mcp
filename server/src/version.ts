// 이 프로그램의 버전. 배포 번들이면 Contents/version.json(빌드할 때 쓴 값), 개발 폴더에서 돌면 "dev".
// 작업 기록마다 붙고(중앙 보고서의 버전별 통계), 팔레트에 보이고, 업데이트 비교에 쓴다.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));   // .../Contents/server/build

function read(): string {
  if (process.env.MY_CIVIL3D_PRODUCT_VERSION) return process.env.MY_CIVIL3D_PRODUCT_VERSION;   // 테스트
  try {
    const version = JSON.parse(readFileSync(join(here, "..", "..", "version.json"), "utf8").replace(/^﻿/, "")).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : "dev";
  } catch {
    return "dev";
  }
}

export const productVersion = read();
export const isRelease = productVersion !== "dev";
// 배포 번들의 폴더(Contents). 개발 폴더면 의미 없음.
export const bundleContents = join(here, "..", "..");
