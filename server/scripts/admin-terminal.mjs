import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { terminateTree } from '../build/ai/processTree.js';

const temporary = await mkdtemp(join(tmpdir(), 'mycivil3d-admin-terminal-'));
try {
  const hook = join(temporary, 'tty.mjs');
  await writeFile(hook, `
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'columns', { value: 40 });
Object.defineProperty(process.stdout, 'rows', { value: 16 });
process.stdin.setRawMode = () => process.stdin;
`);
  const script = join(temporary, 'view.mjs');
  const moduleUrl = pathToFileURL(resolve('build/admin/terminal.js')).href;
  await writeFile(script, `
import { AdminTerminal } from ${JSON.stringify(moduleUrl)};
const ui = new AdminTerminal();
setTimeout(() => ui.work('지연 테스트', 2000), 200);
const first = await ui.page('첫 화면', 'OLD CONTENT', 'FIRST> ');
ui.work();
console.log('FIRST_VALUE:' + first);
const next = await ui.page('둘째 화면', Array.from({length:60}, (_,i)=>'새 내용 ' + i).join('\\n'), 'SECOND> ');
console.log('PAGE_RESULT:' + next);
ui.close();
`);
  const child = spawn(process.execPath, ['--import', pathToFileURL(hook).href, script], { windowsHide: true });
  let output = '', errors = '', pending = '', phase = 0;
  const prompts = ['FIRST> ', '지연 테스트', 'SECOND> ', 'SECOND> ', 'SECOND> ', 'SECOND> '];
  const keys = ['한글', '\r', 'n\r', 'p\r', 'p\r', '\x1b'];
  child.stdout.on('data', chunk => {
    const text = chunk.toString();
    output += text;
    pending += text;
    if (phase < prompts.length && pending.includes(prompts[phase])) {
      pending = '';
      child.stdin.write(keys[phase++]);
    }
  });
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  const timer = setTimeout(() => { void terminateTree(child); }, 15000);
  const code = await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert.equal(code, 0, errors + output);
  assert.equal(phase, prompts.length, output);
  assert.match(output, /FIRST_VALUE:한글/, 'background redraw must preserve typed input');
  assert.match(output, /페이지 2\//, 'n must show the next page');
  assert.match(output, /PAGE_RESULT:b/, 'Esc must return without a free-form value');
  const last = output.split('\x1b[2J\x1b[H').at(-1);
  assert.ok(!last.includes('OLD CONTENT'), 'the previous screen must not remain in the new frame');
  assert.ok(!last.includes('새 내용 59'), 'a small window must paginate long content');
  console.log('Admin terminal passed: page clearing, narrow window pagination, first-page boundary, Esc navigation, typed Korean preserved during progress redraw.');
} finally {
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
