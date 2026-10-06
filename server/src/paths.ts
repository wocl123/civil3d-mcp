import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let resolved: string | undefined;

// 이 사용자의 MyCivil3DMcp 폴더: %LOCALAPPDATA%\MyCivil3DMcp (플러그인 연결 파일도 여기 있다).
export function appDataDir(): string {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "MyCivil3DMcp");
}

// 사용자 데이터(기억, 지식, 로그, 추적, 보낼 묶음)를 두는 폴더 하나.
// 설치 폴더에는 두지 않는다. 그래서 데이터가 두 곳으로 갈라지지 않고, Program Files 설치도 똑같이 동작한다.
// MY_CIVIL3D_DATA_DIR 로 옮길 수 있다(테스트는 임시 폴더를 쓴다). docs/데이터관리_설계.md 참고.
export function dataDir(): string {
  if (resolved) return resolved;
  resolved = process.env.MY_CIVIL3D_DATA_DIR ?? join(appDataDir(), "data");
  mkdirSync(resolved, { recursive: true });
  return resolved;
}
