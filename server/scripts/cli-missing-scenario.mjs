// A PC without the AI CLIs, played through with the real service code and the real setup
// script: the CLI search is limited to empty folders (MY_CIVIL3D_CLI_DIRS), and a fake npm
// "installs" a fake Codex whose login works like the real one. Prints what the user sees.
//   A. Codex not installed: [취소], then [설치] → install, sign-in, ready
//   B. Codex installed but signed out: [로그인] → ready
//   C. Gemini not installed and no Node.js (npm): the window says what to install
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-nocli-'));
const tools = join(here, 'fixtures', 'fake-cli');
process.env.FAKE_CLI_BIN = temporary;
process.env.MY_CIVIL3D_CLI_DIRS = `${temporary};${tools}`;

const { verifyProvider } = await import('../build/ai/aiCli.js');
const { SETUP_SCRIPT } = await import('../build/ai/cliSetup.js');
const { forgetCli } = await import('../build/ai/cliLocator.js');

const say = (who, text) => console.log(`${who.padEnd(8)}│ ${text.split('\n').join('\n' + ' '.repeat(8) + '│ ')}`);
const step = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
// What the palette's [설치] / [로그인] opens (ai/cliSetup.ts), run here in this console; the
// final Enter closes the window.
function window(provider, action) {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SETUP_SCRIPT, '-Provider', provider, '-Action', action],
    { encoding: 'utf8', input: '\n', env: process.env });
  for (const line of output.split(/\r?\n/).filter(line => line.trim())) say('설치 창', line.trim());
  forgetCli(provider);
  return output;
}

try {
  step('A. Codex가 설치되지 않은 PC');
  say('사용자', '팔레트에서 Codex를 누름');
  let state = await verifyProvider('codex');
  say('서비스', `Codex 상태: ${state}`);
  assert.equal(state, 'missing');
  say('팔레트', 'Codex가 이 PC에 설치되어 있지 않습니다. 설치할까요?\n설치 창이 열리고, 설치가 끝나면 로그인까지 이어 갑니다.\n[설치] [취소]');
  say('사용자', '[취소]');
  say('팔레트', 'Codex 설치를 취소했습니다. 다시 누르면 다시 묻습니다.');
  assert.equal(await verifyProvider('codex'), 'missing', 'cancel changes nothing');

  say('사용자', 'Codex를 다시 누르고 [설치]');
  say('팔레트', '설치 창을 열었습니다. 설치가 끝나면 로그인이 이어집니다. 창을 닫은 뒤 AI를 다시 눌러 주세요.');
  const installed = window('codex', 'install');
  assert.match(installed, /설치했습니다/);
  assert.match(installed, /로그인을 확인했습니다/);
  say('사용자', '창을 닫고 Codex를 다시 누름');
  state = await verifyProvider('codex');
  say('서비스', `Codex 상태: ${state}`);
  assert.equal(state, 'ready');
  say('팔레트', 'Codex · 사용 중');

  step('B. Codex는 있지만 로그아웃된 PC');
  await rm(join(temporary, 'codex-logged-in'));
  say('사용자', '팔레트에서 Codex를 누름');
  state = await verifyProvider('codex');
  say('서비스', `Codex 상태: ${state}`);
  assert.equal(state, 'unauthenticated');
  say('팔레트', 'Codex 로그인이 확인되지 않았습니다. 로그인할까요?\n[로그인] [취소]');
  say('사용자', '[로그인]');
  assert.match(window('codex', 'login'), /로그인을 확인했습니다/);
  state = await verifyProvider('codex');
  say('서비스', `Codex 상태: ${state}`);
  assert.equal(state, 'ready');

  step('C. Gemini가 없고 Node.js(npm)도 없는 PC');
  process.env.MY_CIVIL3D_CLI_DIRS = temporary;
  say('사용자', '팔레트에서 Gemini를 누르고 [설치]');
  assert.equal(await verifyProvider('gemini'), 'missing');
  const noNode = window('gemini', 'install');
  assert.match(noNode, /Node\.js\(npm\)가 필요합니다/);
  assert.equal(await verifyProvider('gemini'), 'missing', 'nothing was installed');
  say('서비스', 'Gemini 상태: missing (설치되지 않음, 안내만 표시)');

  console.log('\nCLI missing scenario passed: A install + sign-in, B sign-in, C no Node.js.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
