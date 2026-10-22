// A PC without the AI CLIs, played through with the real service code and the real setup
// script: the CLI search is limited to empty folders (MY_CIVIL3D_CLI_DIRS), and a fake npm
// "installs" a fake Codex whose login works like the real one. Prints what the user sees.
//   A. Codex not installed: [취소], then [설치] → install, sign-in, ready
//   B. Codex installed but signed out: [로그인] → ready
//   C. Gemini(Antigravity) installs without Node.js/npm, even with an obsolete gemini shim present.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'my-civil3d-nocli-'));
const tools = join(here, 'fixtures', 'fake-cli');
process.env.FAKE_CLI_BIN = temporary;
process.env.MY_CIVIL3D_CLI_DIRS = `${temporary};${tools}`;
process.env.MY_CIVIL3D_DATA_DIR = join(temporary, 'data');   // AI 세션 파일을 실제 사용자 폴더에 쓰지 않는다
process.env.MY_CIVIL3D_CLI_ROOT = join(temporary, 'cli-no-node');

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
  await copyFile(join(tools, 'gemini-template.cmd'), join(temporary, 'gemini.cmd'));
  await copyFile(join(tools, 'gemini-template.cmd'), join(temporary, 'gemini-template.cmd'));
  await copyFile(join(tools, 'install-agy.cmd'), join(temporary, 'install-agy.cmd'));
  say('사용자', '팔레트에서 Gemini를 누르고 [설치]');
  assert.equal(await verifyProvider('gemini'), 'missing', 'legacy gemini does not count as supported Google CLI');
  const noNode = window('gemini', 'install');
  assert.match(noNode, /설치했습니다/);
  assert.match(noNode, /Node\.js나 npm은 필요하지 않습니다/);
  assert.equal(await verifyProvider('gemini'), 'ready', 'native Antigravity needs no Node/npm installation');
  await rm(join(process.env.MY_CIVIL3D_CLI_ROOT, 'gemini', 'agy.cmd'));
  await rm(join(temporary, 'gemini-logged-in'));
  forgetCli('gemini');

  step('D. 시스템 npm 없이 동봉 런타임으로 사용자 폴더 설치');
  const runtime = join(temporary, '한글 번들 런타임');
  const cliRoot = join(temporary, '앱 전용 CLI');
  await mkdir(runtime);
  await copyFile(process.execPath, join(runtime, 'node.exe'));
  await copyFile(join(tools, 'npm.cmd'), join(runtime, 'npm.cmd'));
  await copyFile(join(tools, 'codex-template.cmd'), join(runtime, 'codex-template.cmd'));
  await copyFile(join(tools, 'gemini-template.cmd'), join(runtime, 'gemini-template.cmd'));
  await copyFile(join(tools, 'install-agy.cmd'), join(runtime, 'install-agy.cmd'));
  process.env.MY_CIVIL3D_NODE_EXE = join(runtime, 'node.exe');
  process.env.MY_CIVIL3D_CLI_ROOT = cliRoot;
  await rm(join(temporary, 'codex.cmd'));
  forgetCli('codex');
  assert.equal(await verifyProvider('codex'), 'missing');
  assert.match(window('codex', 'install'), /로그인을 확인했습니다/);
  const { locateCli, cliPath } = await import('../build/ai/cliLocator.js');
  const location = await locateCli('codex');
  assert.equal(location.dir, join(cliRoot, 'codex'));
  assert.ok((await cliPath('codex', location)).includes(runtime));
  assert.equal(await verifyProvider('codex'), 'ready');

  step('E. Gemini: bundled runtime install, Google sign-in, then sign-in again');
  assert.equal(await verifyProvider('gemini'), 'missing');
  assert.match(window('gemini', 'login'), /CLI가 없어 로그인할 수 없습니다/);
  assert.equal(await verifyProvider('gemini'), 'missing', 'login alone must not silently install');
  assert.match(window('gemini', 'install'), /설치했습니다/);
  assert.equal(await verifyProvider('gemini'), 'ready');
  await rm(join(temporary, 'gemini-logged-in'));
  assert.equal(await verifyProvider('gemini'), 'unauthenticated');
  window('gemini', 'login');
  assert.equal(await verifyProvider('gemini'), 'ready');

  step('F. Failed Antigravity install remains missing');
  await rm(join(cliRoot, 'gemini', 'agy.cmd'));
  forgetCli('gemini');
  process.env.FAKE_AGY_INSTALL_FAIL = '1';
  assert.match(window('gemini', 'install'), /CLI 설치에 실패했습니다/);
  assert.equal(await verifyProvider('gemini'), 'missing');
  delete process.env.FAKE_AGY_INSTALL_FAIL;

  console.log('\nCLI missing scenario passed: Claude/Codex flow, native Antigravity without npm, legacy shim ignored, login, installation failure and Korean/space paths.');
} finally {
  // 잠시 뒤 저장되는 세션 파일이 정리와 충돌하지 않게 저장 큐를 마무리한다.
  await new Promise(resolve => setTimeout(resolve, 750));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });   // AI 세션 저장이 끝날 때까지 기다리며 지운다
}
