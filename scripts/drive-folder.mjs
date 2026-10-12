// Resolve public Drive files from the administrator's folder link; no OAuth or per-file setup.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function folderId(link) {
  const id = /\/folders\/([\w-]+)/.exec(link)?.[1] ?? link.trim();
  if (!/^[\w-]{10,200}$/.test(id)) throw new Error('Google Drive 폴더 공유 링크를 입력하세요.');
  return id;
}
export function parsePublicFolder(html) {
  // Drive serves its folder's file metadata as escaped JSON inside this assignment.
  const raw = /\[['"]_DRIVE_ivd['"]\]\s*=\s*'((?:\\.|[^'\\])*)'/.exec(html)?.[1];
  if (!raw) throw new Error('Drive 공개 폴더 목록을 읽지 못했습니다. 링크가 있는 모든 사용자(뷰어) 공유인지 확인하세요.');
  const escaped = raw.replace(/\\x([\da-f]{2})|\\u([\da-f]{4})|\\(['"\\/bfnrt])/gi, (_, x, u, simple) => {
    if (x || u) return String.fromCharCode(parseInt(x ?? u, 16));
    return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[simple] ?? simple;
  });
  const rows = JSON.parse(escaped)?.[0];
  if (!Array.isArray(rows)) throw new Error('Drive 공개 폴더 목록 형식이 바뀌었습니다.');
  return rows.filter(r => Array.isArray(r) && /^[\w-]{10,200}$/.test(r[0]) && typeof r[2] === 'string')
    .map(r => ({ id: r[0], name: r[2], mime: r[3] }));
}
export async function listPublicFolder(id) {
  const base = process.env.MY_CIVIL3D_FOLDER_BASE ?? 'https://drive.google.com/drive/folders/';
  const response = await fetch(base + encodeURIComponent(id), { signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error('공유폴더 조회 실패: HTTP ' + response.status);
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('공유폴더 목록 크기 제한 초과'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return parsePublicFolder(Buffer.concat(parts).toString('utf8'));
}
export async function findPublicFile(parent, name) {
  const matches = (await listPublicFolder(parent)).filter(entry => entry.name === name);
  if (matches.length > 1) throw new Error('같은 이름의 Drive 파일이 여러 개입니다: ' + name);
  return matches[0];
}
export async function resolveReleaseFolder(link) {
  const parent = folderId(link);
  const children = await listPublicFolder(parent);
  if (children.some(entry => entry.name === 'latest.json')) return parent;
  const folders = children.filter(entry => entry.name === 'MyCivil3DMcp-release' && entry.mime === 'application/vnd.google-apps.folder');
  if (folders.length !== 1) throw new Error('공유폴더 안의 MyCivil3DMcp-release 배포폴더를 찾지 못했습니다. Drive 업로드 후 다시 시도하세요.');
  return folders[0].id;
}
export async function configureFolder(configFile, installer = false, waitMs = 15 * 60 * 1000) {
  const config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
  const until = Date.now() + waitMs;
  let error;
  do {
    try {
      const releaseFolderId = await resolveReleaseFolder(config.folderLink);
      const entry = await findPublicFile(releaseFolderId, installer ? '설치.exe' : 'latest.json');
      if (entry) {
        config.releaseFolderId = releaseFolderId;
        config[installer ? 'installerId' : 'manifestId'] = entry.id;
        await writeFile(configFile, JSON.stringify(config, null, 2));
        console.log((installer ? '설치 EXE' : '최신 버전 정보') + ' 공유파일 자동 연결 완료');
        return config;
      }
      error = new Error('Drive에 파일이 아직 보이지 않습니다.');
    } catch (e) { error = e; }
    if (Date.now() >= until) break;
    await delay(Math.min(5000, Math.max(0, until - Date.now())));
  } while (Date.now() < until);
  throw error;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await configureFolder(resolve(process.argv[2]), process.argv.includes('--installer'));
