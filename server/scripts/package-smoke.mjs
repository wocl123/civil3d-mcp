// 배포본 Node·운영 의존성·기본 지식·설치 경로를 실제 프로세스로 검사한다. AI 요청은 보내지 않는다.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startFakeCivil } from './fixtures/fake-civil.mjs';
const bundle = resolve(process.argv[2]);
const runtime = join(bundle, 'Contents', 'node', 'node.exe');
const server = join(bundle, 'Contents', 'server');
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-bundle-'));
const empty = join(temp, 'empty'); await mkdir(empty);
const connection = join(temp, 'connection.json');
const bridge = await startFakeCivil(connection);
const portProbe = createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r));
const port = portProbe.address().port; await new Promise(r => portProbe.close(r));
const env = { ...process.env, MY_CIVIL3D_NODE_EXE: runtime, MY_CIVIL3D_CLI_DIRS: empty,
  MY_CIVIL3D_SERVICE_PORT: String(port), MY_CIVIL3D_CONNECTION_FILE: connection,
  MY_CIVIL3D_DATA_DIR: join(temp, '한글 사용자 데이터'), MY_CIVIL3D_CLAUDE_QUOTA_FILE: join(temp, 'quota.json'),
  MY_CIVIL3D_CLAUDE_QUOTA_MODE: 'statusline', MY_CIVIL3D_SYNC: 'off' };
for (const key of Object.keys(env)) if (/^path$/i.test(key)) delete env[key];
env.Path = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
let errors = '';
const child = spawn(runtime, [join(server, 'build/localService.js')], { env, cwd: temp, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
child.stderr.on('data', c => { errors += c.toString(); });
try {
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i=0;i<60;i++) { try { await fetch(base + '/api/providers'); ready=true;break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  assert.ok(ready, errors);
  assert.equal((await fetch(base + '/api/providers')).status,403);
  const headers = { 'X-My-Civil3D-Token': 'a'.repeat(64) };
  const drawing = await (await fetch(base + '/api/drawing',{headers})).json();
  assert.equal(drawing.status.drawingName,'FAKE-SITE.dwg');
  const quota = await (await fetch(base + '/api/quota?provider=claude',{headers})).json();
  assert.equal(quota.quota.status,'unavailable');
  const script = join(temp,'배포 실행 검사.mjs');
  const uri = pathToFileURL(join(server,'build')).href;
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import { writeFile } from 'node:fs/promises';
    import { paletteLaunch } from ${JSON.stringify(uri + '/ai/paletteWorkspace.js')};
    import { getQuota } from ${JSON.stringify(uri + '/ai/quota.js')};
    import { loadCriteria } from ${JSON.stringify(uri + '/criteria/criteriaStore.js')};
    for (const provider of ['claude','codex','gemini']) {
      const launch = await paletteLaunch(provider,true,'package-test',[],'fake-drawing-1');
      assert.ok(launch.cwd.startsWith(process.env.MY_CIVIL3D_DATA_DIR));
    }
    await loadCriteria('도로구조규칙');
    const now = Date.now();
    const record = {capturedAt:now,rate_limits:{five_hour:{used_percentage:25,resets_at:Math.floor(now/1000)+3600}}};
    await writeFile(process.env.MY_CIVIL3D_CLAUDE_QUOTA_FILE,JSON.stringify(record));
    assert.equal((await getQuota('claude',true)).status,'available');
    record.capturedAt=now-16*60000;
    await writeFile(process.env.MY_CIVIL3D_CLAUDE_QUOTA_FILE,JSON.stringify(record));
    assert.equal((await getQuota('claude',true)).status,'unavailable');
  `,'utf8');
  execFileSync(runtime,[script],{env,cwd:temp,windowsHide:true,encoding:'utf8',timeout:30000});
  const mcpEnv = {...env,MY_CIVIL3D_MCP_PROFILE:'palette'};
  const mcp = spawn(runtime,[join(server,'build/index.js')],{env:mcpEnv,cwd:temp,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let output='';mcp.stdout.on('data',c=>output+=c.toString());mcp.stderr.resume();
  mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'bundle-smoke',version:'1'}}})+'\n');
  try { for(let i=0;i<50 && !output.includes('"id":1');i++) await new Promise(r=>setTimeout(r,100));assert.ok(output.includes('"id":1'),output); }
  finally { mcp.kill(); }
  console.log('Bundle smoke passed: bundled Node, production dependencies, service authentication, bridge, MCP, default knowledge, isolated workspace, missing/stale quota.');
} finally {
  const closed = new Promise(r=>child.once('close',r));
  if(child.exitCode===null){ child.kill();await closed; }
  await new Promise(r=>bridge.close(r));
  await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
