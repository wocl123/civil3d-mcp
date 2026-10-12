// Opt-in live intake check. Uses a persistent, isolated test installation under .package-work.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const repo = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(join(repo, '.drive-deploy.json'), 'utf8'));
const data = join(repo, '.package-work', 'ingest-live', 'data');
mkdirSync(data, { recursive: true });
process.env.MY_CIVIL3D_DATA_DIR = data;
delete process.env.MY_CIVIL3D_INGEST_TEST_URL;
const { install } = await import('../server/build/data/install.js');
const { webMemberSync } = await import('../server/build/ingest/memberSync.js');
const { loadState } = await import('../server/build/sync/syncState.js');
const { installId } = await install();
const pending = join(data, 'outbox', 'pending'); mkdirSync(pending, { recursive: true });
const packageId = installId + '-live-check';
const at = new Date().toISOString().slice(0, 13);
const archive = join(data, 'test-package.json');
if (!existsSync(archive)) writeFileSync(archive, JSON.stringify({
  schema: 1, packageId, installId, createdAt: at, records: [{
    type: 'turn', at, id: 'live-check-00001',
    question: '관리자 자동 수신 연결 검증용 기록', answer: '자동 등록과 수신 확인 테스트', kind: 'chat', appVersion: '0.1.4'
  }]
}));
const packageText = readFileSync(archive, 'utf8');
writeFileSync(join(pending, packageId + '.json'), packageText);
assert.equal((await webMemberSync(config.ingestUrl, await loadState())).sent, 1);
assert.equal(readdirSync(pending).length, 0, 'Only acknowledged packages leave the queue');
// Replay exactly the same package to confirm the deployed receiver deduplicates it.
writeFileSync(join(pending, packageId + '.json'), packageText);
assert.equal((await webMemberSync(config.ingestUrl, await loadState())).sent, 1);
assert.equal(readdirSync(pending).length, 0);
const remote = join(config.collectionRoot, 'MyCivil3DMcp-' + installId, 'packages', packageId + '.json');
let stored;
for (let attempt = 0; attempt < 20; attempt++) {
  try { stored = JSON.parse(readFileSync(remote, 'utf8')); break; } catch {}
  await new Promise(r => setTimeout(r, 1000));
}
assert.ok(stored, 'Acknowledged by web app but local Drive copy has not arrived: ' + remote);
assert.equal(stored.transportSha256, createHash('sha256').update(packageText).digest('hex'));
assert.equal(stored.records[0].question, '관리자 자동 수신 연결 검증용 기록');
console.log(JSON.stringify({ ok: true, installId, packageId, records: stored.records.length, deduplicated: true, driveFile: remote }));
