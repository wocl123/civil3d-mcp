import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-knowledge-'));
process.env.MY_CIVIL3D_KNOWLEDGE_DIR = temporary;
const { appendFacts, knowledgeFile, knowledgePrompt, parseKnowledge, readKnowledge } =
  await import('../build/knowledge/knowledgeStore.js');
const { splitFacts } = await import('../build/knowledge/factBlock.js');
const { dropSelfNotes, FactsFilter } = await import('../build/workflows/factsFilter.js');
const { listRules, readRule, rulesPrompt, rulesDir } = await import('../build/knowledge/rulesStore.js');

try {
  const reply = '현재 지표면은 2개입니다.\n<facts>[{"title":"EG 지표면 용도","content":"EG는 원지반 지표면이다.","basis":"user_answer","evidence":"사용자: EG는 원지반","replaces":null},{"title":"x","content":"추정","basis":"guess"}]</facts>';
  const split = splitFacts(reply);
  assert.equal(split.answer, '현재 지표면은 2개입니다.');
  // Facts without a valid basis, such as guesses, are dropped.
  assert.equal(split.proposals.length, 1);
  // Hedged facts are guesses and are dropped as well.
  assert.equal(splitFacts('답<facts>[{"title":"C-ROAD 용도","content":"도로 중심선으로 보인다.","basis":"drawing"}]</facts>').proposals.length, 0);
  assert.deepEqual(splitFacts('답만 있습니다.'), { answer: '답만 있습니다.', proposals: [] });
  assert.equal(splitFacts('답 <facts>not json</facts>').answer, '답');

  // Leading self-notes in English are dropped, in the final answer and while streaming.
  const noted = 'Next question is 지역. Record the criteria fact.\n\n지역은요?\n1. 도시지역';
  assert.equal(dropSelfNotes(noted), '지역은요?\n1. 도시지역');
  const filter = new FactsFilter();
  assert.equal(noted.match(/.{1,5}/gs).map(part => filter.push(part)).join(''), '지역은요?\n1. 도시지역');
  assert.equal(dropSelfNotes('Civil 3D 선형은 3개입니다.'), 'Civil 3D 선형은 3개입니다.');
  assert.equal(dropSelfNotes('English only answer, nothing else here.'), 'English only answer, nothing else here.');

  const scope = { key: 'd:/site/a.dwg', label: 'a.dwg', state: 'r1' };
  assert.equal(knowledgeFile({ key: '', label: '', state: 'no-drawing' }), undefined);
  const first = await appendFacts(scope, split.proposals, 'claude');
  assert.equal(first.length, 1);
  // The same fact again is not duplicated.
  assert.deepEqual(await appendFacts(scope, split.proposals, 'codex'), []);

  const replaced = await appendFacts(scope, [{ title: 'EG 지표면 용도', content: 'EG는 계획면 지표면이다.',
    basis: 'user_answer', evidence: '사용자 정정', replaces: first[0] }], 'codex');
  const facts = await readKnowledge(scope);
  assert.equal(facts.length, 2);
  assert.equal(facts.find(fact => fact.id === first[0]).replaced, true);
  const prompt = knowledgePrompt(facts);
  assert.match(prompt, /계획면/);
  assert.doesNotMatch(prompt, /원지반/);

  // Sections written by a person are still read.
  const text = await readFile(knowledgeFile(scope), 'utf8');
  const edited = parseKnowledge(text + '\n## 측량점 레이어\nSV_POINTS 레이어가 현황 측량점이다.\n');
  assert.equal(edited.at(-1).content, 'SV_POINTS 레이어가 현황 측량점이다.');
  assert.ok(replaced[0].startsWith('F-'));
  assert.ok(knowledgeFile(scope).includes(join(temporary, 'drawings')));

  // Default rules are installed into an empty rules folder.
  const rules = await listRules();
  assert.ok(rules.some(rule => rule.always));
  assert.ok(rules.length >= 2);
  const rulePrompt = await rulesPrompt();
  assert.match(rulePrompt, /핵심 규칙/);
  assert.match(rulePrompt, /read_knowledge_rule/);
  // Only listed rule names can be read.
  assert.ok((await readRule('도면_읽기규칙'))?.body.includes('모형 공간'));
  assert.equal(await readRule('../drawings/a'), undefined);
  assert.equal(rulesDir(), join(temporary, 'rules'));
  assert.ok((await readRule('선형'))?.body.includes('측점'));
  assert.ok((await readRule('종단'))?.body.includes('VIP'));
  process.stdout.write('Drawing knowledge and common rules smoke test passed.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
