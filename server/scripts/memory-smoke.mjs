import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-memory-'));
process.env.MY_CIVIL3D_MEMORY_FILE = join(temporary, 'memory.json');
const { normalizeQuestion, hashKey, findAnswer, saveAnswer } =
  await import('../build/memory/memoryStore.js');

try {
  assert.equal(normalizeQuestion('  지표면   몇 개야? '), normalizeQuestion('지표면 몇 개야?'));
  assert.notEqual(normalizeQuestion('R=50.0'), normalizeQuestion('R=500'));
  assert.notEqual(normalizeQuestion('+3%'), normalizeQuestion('-3%'));
  assert.notEqual(normalizeQuestion('EG 표고'), normalizeQuestion('FG 표고'));

  const scope = { key: 'd:/site.dwg', label: 'site.dwg', state: 's1', drawingId: 'drawing-1' };
  const key = hashKey(normalizeQuestion('지표면 몇 개야?'));
  const usage = { inputTokens: 100, outputTokens: 10, cachedInputTokens: 0, costUsd: 0.01 };
  await saveAnswer({ kind: 'chat', provider: 'claude', key, question: '지표면 몇 개야?', scope: scope.key, state: scope.state, drawingId: scope.drawingId, answer: '2개', usage });

  assert.equal((await findAnswer('chat', 'claude', key, scope))?.answer, '2개');
  // Each AI keeps its own answers.
  assert.equal(await findAnswer('chat', 'codex', key, scope), undefined);
  // A changed drawing state makes earlier answers unusable.
  assert.equal(await findAnswer('chat', 'claude', key, { ...scope, state: 's2' }), undefined);
  assert.equal(await findAnswer('chat', 'claude', key, { ...scope, key: 'd:/other.dwg' }), undefined);

  // Saving the same question again replaces the earlier entry.
  await saveAnswer({ kind: 'chat', provider: 'claude', key, question: '지표면 몇 개야?', scope: scope.key, state: scope.state, drawingId: scope.drawingId, answer: '3개', usage });
  assert.equal((await findAnswer('chat', 'claude', key, scope))?.answer, '3개');

  await new Promise(resolve => setTimeout(resolve, 100));
  const saved = JSON.parse(await readFile(process.env.MY_CIVIL3D_MEMORY_FILE, 'utf8'));
  assert.equal(saved.answers.length, 1);
  process.stdout.write('Palette memory smoke test passed.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
