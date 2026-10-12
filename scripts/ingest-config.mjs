import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [action, endpoint, givenRoot] = process.argv.slice(2);
if (!['--probe', '--configure'].includes(action) || !/^https:\/\/script\.google\.com\/macros\/s\/[\w-]{20,200}\/exec$/.test(endpoint ?? ''))
  throw new Error('사용법: node scripts/ingest-config.mjs --configure <Apps Script /exec URL> [비공개 수집폴더 로컬 경로]');
const response = await fetch(endpoint, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
if (!response.ok) throw new Error('수신 웹앱 연결 실패: HTTP ' + response.status);
const text = await response.text();
if (text.length > 16384) throw new Error('수신 웹앱 준비 응답이 너무 큽니다.');
let health;
try { health = JSON.parse(text); } catch { throw new Error('수신 웹앱이 JSON을 반환하지 않습니다. 나로 실행/모든 사용자 접근으로 배포하세요.'); }
if (health.schema !== 1 || health.app !== 'my-civil3d-mcp-intake' || health.protocol !== 1 || health.ready !== true)
  throw new Error('수신 웹앱 setupIntake를 먼저 실행하고 비공개 수집폴더 설정을 확인하세요.');
if (action === '--configure') {
  const file = join(repo, '.drive-deploy.json');
  const config = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const collectionRoot = resolve(givenRoot ?? join(dirname(config.driveRoot), 'MyCivil3DMcp-data'));
  const publicRoot = resolve(config.driveRoot);
  if (collectionRoot.toLowerCase() === publicRoot.toLowerCase() || collectionRoot.toLowerCase().startsWith(publicRoot.toLowerCase() + sep))
    throw new Error('수집폴더를 공개 배포폴더 안에 둘 수 없습니다.');
  if (!existsSync(collectionRoot)) throw new Error('비공개 수집폴더가 로컬 Drive에 아직 없습니다. setupIntake 후 동기화를 확인하세요.');
  await writeFile(file, JSON.stringify({ ...config, ingestUrl: endpoint, collectionRoot }, null, 2));
  console.log('관리자 자동 수신 설정 저장 완료. 배포하기.bat으로 새 설치 EXE를 만드세요.');
} else console.log('수신 웹앱 준비 확인 완료');
