// 실제 열려 있는 도면의 목록 조회만 계측한다. AI·계획·적용·설치는 실행하지 않는다.
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../..', import.meta.url));
const base = join(process.env.LOCALAPPDATA, 'MyCivil3DMcp');
const candidates = process.env.MY_CIVIL3D_CONNECTION_FILE ? [process.env.MY_CIVIL3D_CONNECTION_FILE] : [
  join(base, 'internal-data', 'connection.json'), join(base, 'connection.json')
];
const found = (await Promise.all(candidates.map(async path => ({ path,
  modified: await stat(path).then(info => info.mtimeMs).catch(() => 0) })))).sort((a, b) => b.modified - a.modified);
if (!found[0]?.modified) throw new Error('실행 중인 Civil 3D 연결 파일을 찾지 못했습니다.');
await mkdir(join(repository, '.package-cache'), { recursive: true });
const data = await mkdtemp(join(repository, '.package-cache', 'live-fast-read-'));
process.env.MY_CIVIL3D_CONNECTION_FILE = found[0].path;
process.env.MY_CIVIL3D_DATA_DIR = data;
process.env.MY_CIVIL3D_SYNC = 'off';
process.env.MY_CIVIL3D_AUTO_UPDATE = 'off';
const boot = performance.now();
const { answerChat } = await import('../build/workflows/paletteChat.js');
const { quickDrawingRoute } = await import('../build/workflows/quickDrawing.js');
const bootstrapMs = Math.round(performance.now() - boot);
const question = '치수선 목록';
if (quickDrawingRoute(question)?.operation) throw new Error('이 검사는 조회 경로만 허용합니다.');
const samples = [];
for (let i = 0; i < 3; i++) {
  const started = performance.now();
  const result = await answerChat('claude', question);
  if (result.usage.inputTokens || result.usage.outputTokens || result.fixes?.length || result.applied?.length) {
    throw new Error('조회 검사의 AI/계획/쓰기 금지 조건을 위반했습니다.');
  }
  samples.push(Math.round(performance.now() - started));
}
const report = { readOnly: true, modelCalls: 0, bootstrapMs, samplesMs: samples,
  minMs: Math.min(...samples), maxMs: Math.max(...samples),
  meanMs: Math.round(samples.reduce((sum, ms) => sum + ms, 0) / samples.length) };
await writeFile(join(data, 'benchmark.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
