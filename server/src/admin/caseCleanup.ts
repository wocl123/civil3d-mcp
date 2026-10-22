// 완료·버림 사례의 Drive 원본만 정리한다. 다른 사례가 섞인 묶음은 해당 기록만 뺀다.
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findDriveRoot, findMemberFolders, type MemberFolder } from "../drive/driveFolders.js";
import { writeAtomic } from "../files.js";
import { caseRecordKey, type AdminStore } from "./adminStore.js";
import { validPackage } from "./validate.js";

export type CaseCleanupResult = {
  deletedFiles: number;
  rewrittenFiles: number;
  removedRecords: number;
  freedBytes: number;
  pendingCases: number;
  problems: string[];
};

const within = (root: string, target: string) => {
  const part = relative(root, target);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
};

async function packageFiles(root: string, directory: string): Promise<string[]> {
  const files: string[] = [];
  // 삭제에서는 읽기 오류를 빈 목록으로 바꾸지 않는다. 정리 완료로 오인하면 안 된다.
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.endsWith(".json")) {
      files.push(item.name);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(item.name)) {
      const day = join(directory, item.name);
      await safePath(root, day);
      for (const entry of await readdir(day)) {
        if (entry.endsWith(".json")) {
          files.push(join(item.name, entry));
        }
      }
    }
  }

  return files.sort();
}

// 경로 바깥으로 향하는 링크나 패키지 대신 놓인 디렉터리는 변경하지 않는다.
async function safePath(root: string, file: string): Promise<void> {
  if (!within(root, resolve(file))) {
    throw new Error("수집 폴더 밖의 경로는 정리하지 않습니다.");
  }

  let current = root;
  for (const part of relative(root, file).split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink() || !within(root, await realpath(current))) {
      throw new Error("링크 경로는 정리하지 않습니다.");
    }
  }
}

async function cleanPackage(store: AdminStore, root: string, folder: MemberFolder, name: string,
  keys: Set<string>, result: CaseCleanupResult): Promise<void> {
  const file = join(folder.path, "packages", name);
  await safePath(root, file);
  if (!(await lstat(file)).isFile()) {
    throw new Error("일반 JSON 파일이 아닙니다.");
  }

  const text = await readFile(file, "utf8");
  const body = JSON.parse(text.replace(/^\uFEFF/u, "")) as Record<string, unknown>;
  const { packageId, records } = validPackage(body, folder.installId);
  if (packageId !== basename(name, ".json") || records.length !== (body.records as unknown[]).length) {
    throw new Error("파일 이름 또는 기록 형식이 맞지 않습니다.");
  }

  // 원문은 유지한다. 검증 결과로 재직렬화하면 다른 사례의 필드가 없어질 수 있다.
  const source = body.records as Record<string, unknown>[];
  const remaining = source.filter(record => !keys.has(caseRecordKey(folder.installId, record) ?? ""));
  if (remaining.length === source.length) {
    return;
  }

  if (!store.packages.has(packageId)) {
    throw new Error("아직 가져오지 않은 묶음입니다. 새 데이터 가져오기 후 재시도합니다.");
  }

  // 관리자 워커가 작업을 직렬화한다. 강제 중단 때 남는 Drive 잠금 파일은 만들지 않는다.
  await safePath(root, file);
  if (await readFile(file, "utf8") !== text) {
    throw new Error("검사 중 파일이 바뀌었습니다. 다음 동기화에서 재시도합니다.");
  }

  let size = 0;
  if (remaining.length) {
    const updated = JSON.stringify({ ...body, records: remaining });
    await writeAtomic(file, updated);
    size = Buffer.byteLength(updated);
    result.rewrittenFiles++;
  } else {
    await rm(file);
    result.deletedFiles++;
  }

  result.removedRecords += source.length - remaining.length;
  result.freedBytes += Math.max(0, Buffer.byteLength(text) - size);
}

export async function cleanupDriveCases(store: AdminStore, configured?: string,
  selected?: string[]): Promise<CaseCleanupResult> {
  const keys = new Set(Object.entries(store.cases)
    .filter(([key, item]) => ["done", "discarded"].includes(item.status) && (!selected || selected.includes(key)))
    .map(([key]) => key));
  const result: CaseCleanupResult = {
    deletedFiles: 0, rewrittenFiles: 0, removedRecords: 0, freedBytes: 0, pendingCases: 0, problems: []
  };
  if (!keys.size) {
    return result;
  }

  // 네트워크 중단·워커 종료가 있어도 재시도할 대상은 먼저 남긴다.
  for (const key of keys) {
    store.cases[key].driveCleanup = "pending";
  }

  store.saveCases();
  const failed = new Set<string>();
  try {
    const configuredRoot = findDriveRoot(configured);
    if (!configuredRoot) {
      throw new Error("Drive 수집 폴더에 연결할 수 없습니다. 다음 동기화에서 삭제를 재시도합니다.");
    }

    const root = await realpath(configuredRoot);
    const folders = await findMemberFolders(root);
    const installs = new Set([...keys].map(key => key.split(":")[0]));
    for (const installId of installs) {
      const member = store.members[installId];
      const folder = folders.find(item => item.installId === installId && item.name === member?.folder);
      try {
        if (!folder || member.blocked) {
          throw new Error("확인된 사용자 폴더가 없거나 차단된 사용자입니다.");
        }

        await safePath(root, join(folder.path, "member.json"));
        const directory = join(folder.path, "packages");
        await safePath(root, directory);
        for (const name of await packageFiles(root, directory)) {
          try {
            await cleanPackage(store, root, folder, name, keys, result);
          } catch (error) {
            failed.add(installId);
            result.problems.push(`${installId}/${name}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        failed.add(installId);
        result.problems.push(`${installId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    for (const key of keys) {
      failed.add(key.split(":")[0]);
    }

    result.problems.push(error instanceof Error ? error.message : String(error));
  }

  for (const key of keys) {
    const pending = failed.has(key.split(":")[0]);
    store.cases[key].driveCleanup = pending ? "pending" : "done";
    if (pending) {
      result.pendingCases++;
    }
  }

  store.saveCases();
  return result;
}

export function caseCleanupText(result: CaseCleanupResult): string {
  return `Drive 원본: 기록 ${result.removedRecords}건 삭제 · 빈 파일 ${result.deletedFiles}개 삭제 · ` +
    `혼합 파일 ${result.rewrittenFiles}개 정리 (${result.freedBytes}바이트 감소).` +
    (result.removedRecords ? "\n클라우드에는 Drive 동기화 후 반영됩니다." : "") +
    (result.deletedFiles ? "\n용량 확보: Drive 휴지통에 남은 해당 파일은 별도로 영구 삭제해야 합니다." : "") +
    (result.pendingCases ? `\n삭제 대기 ${result.pendingCases}건. 다음 동기화 또는 8번 메뉴에서 재시도합니다.` : "") +
    (result.problems.length ? "\n" + result.problems.join("\n") : "");
}
