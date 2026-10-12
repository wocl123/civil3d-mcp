import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const temp = await mkdtemp(join(tmpdir(), 'mycivil3d-ai-errors-'));
Object.assign(process.env, { MY_CIVIL3D_DATA_DIR: join(temp,'data'), MY_CIVIL3D_CLI_DIRS:temp,
 MY_CIVIL3D_CLAUDE_QUOTA_MODE:'statusline', MY_CIVIL3D_CLAUDE_QUOTA_FILE:join(temp,'quota.json'), FAKE_AI_RESULT_FILE:join(temp,'result.json') });
const now=Date.now(), first=new Date(now+3600000).toISOString(), second=new Date(now+86400000).toISOString();
const { parseCliFailure:parse, formatCliFailure:format, rememberLimit, observedQuota, clearLimit }=await import('../build/ai/cliFailure.js');
const { paletteMessage }=await import('../build/errors/failureGuide.js');
const { errorKind }=await import('../build/sync/records.js');
const response=(v,code=1,stderr='')=>({code,stderr,stdout:typeof v==='string'?v:JSON.stringify(v)});
const stream=(...events)=>events.map(e=>JSON.stringify(e)).join('\n');
const event={type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour',resetsAt:Date.parse(first)/1000}};
const terminal={type:'result',is_error:true,result:"You've hit your limit"};
const quota={status:'available',windows:[
 {label:'5시간',remainingPercent:0,usedPercent:100,resetsAt:first},
 {label:'7일',remainingPercent:0,usedPercent:100,resetsAt:second}
],ordinaryUsageAllowed:null,message:''};
try {
 const cases=[
 ['claude',response(stream(event,terminal)),'limit'],
 ['claude',response({type:'result',is_error:true,errors:['rate_limit'],result:'Denied'},0),'limit'],
 ['claude',response({type:'result',is_error:true,errors:['authentication_failed']}),'auth'],
 ['codex',response({type:'turn.failed',error:{message:'Limit reached',codexErrorInfo:'usageLimitExceeded'}},0),'limit'],
 ['gemini',response({error:{code:429,type:'TerminalQuotaError',message:'Quota exceeded',details:[{retryDelay:'120s'}]}}),'limit'],
 ['gemini',response({error:{code:401,message:'Unauthorized'}},0),'auth'],
 ['codex',response('',1,'unknown option --bad'),'execution'],
 ['claude',response('',1,'fetch failed ECONNRESET'),'network'],
 ['claude',response({type:'result',is_error:true,errors:['billing_error'],result:'Credit balance is too low'}),'billing']];
 for(const[provider,raw,kind]of cases){
  const failure=parse(provider,raw,now);assert.equal(failure.kind,kind);
  const message=format(provider,failure,undefined,now);assert.equal(paletteMessage(message),message);
  if(kind!=='auth')assert.doesNotMatch(message,/로그인/);
  if(kind==='limit')assert.equal(errorKind(message),'ai_limit');
 }
 const failure=parse('claude',response(stream(event,terminal)),now);
 assert.deepEqual(failure.resetsAt,[first]);
 const message=format('claude',failure,quota,now);
 assert.match(message,/남은 한도 0%/);assert.match(message,/5시간/);assert.match(message,/7일/);
 const lastLine=message.split('\n').find(line=>line.startsWith('복구 예정:'));
 assert.ok(lastLine.includes(new Date(second).toLocaleString('ko-KR',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short'})));
 const unknown=parse('gemini',response({error:{code:429}}),now);
 assert.match(format('gemini',unknown,undefined,now),/복구 시각.*확인할 수 없습니다/);
 assert.doesNotMatch(format('gemini',unknown,undefined,now),/0%/);
 assert.equal(parse('claude',response(stream({type:'rate_limit_event',rate_limit_info:{status:'allowed_warning'}},{type:'result',is_error:false,result:'Explain quota limits and login.'}),0)),undefined);
 assert.equal(parse('codex',response(stream({type:'error',message:'rate limit transient retry'},{type:'turn.completed'}),0)),undefined);
 assert.equal(parse('gemini',response({response:'401 and quota are normal topics'},0)),undefined);
 rememberLimit('claude',failure,message,quota,now);assert.equal(observedQuota('claude',now).ordinaryUsageAllowed,false);
 assert.equal(observedQuota('claude',now+15*60000),undefined);
 rememberLimit('claude',failure,message,undefined,now);assert.equal(observedQuota('claude',Date.parse(first)+1),undefined);
 rememberLimit('gemini',unknown,'limit',undefined,now);assert.equal(observedQuota('gemini',now+60001),undefined);
 clearLimit('claude');clearLimit('gemini');
 const helper=join(temp,'fake.mjs');
 const helperBody=[
 "import fs from 'node:fs';import readline from 'node:readline';",
 "const args=process.argv.slice(3);",
 "if(args[0]==='auth'||args[0]==='login'){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}",
 "if(args[0]==='app-server'){const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{const r=JSON.parse(line);",
 "if(r.id===1)console.log(JSON.stringify({id:1,result:{}}));",
 "if(r.id===2)console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:100,windowDurationMins:300,resetsAt:"+Date.parse(first)/1000+"},secondary:{usedPercent:100,windowDurationMins:10080,resetsAt:"+Date.parse(second)/1000+"}}}}));});",
 "}else{const data=JSON.parse(fs.readFileSync(process.env.FAKE_AI_RESULT_FILE,'utf8'));process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(data.stdout);process.stderr.write(data.stderr);process.exit(data.code);});}"
 ].join('\n');
 await writeFile(helper,helperBody);
 for(const provider of ['claude','codex','gemini']){
  const wrapper=process.platform==='win32'?'@"'+process.execPath+'" "'+helper+'" '+provider+' %*\r\n'
   :'#!/bin/sh\nexec "'+process.execPath+'" "'+helper+'" '+provider+' "$@"\n';
  await writeFile(join(temp,provider+(process.platform==='win32'?'.cmd':'')),wrapper,{mode:0o700});
 }
 await writeFile(process.env.MY_CIVIL3D_CLAUDE_QUOTA_FILE,JSON.stringify({capturedAt:now,rate_limits:{
 five_hour:{used_percentage:100,resets_at:Date.parse(first)/1000},seven_day:{used_percentage:100,resets_at:Date.parse(second)/1000}}}));
 const {verifyProvider,askProvider,getProviderState}=await import('../build/ai/aiCli.js');
 const {getQuota}=await import('../build/ai/quota.js');
 const use=raw=>writeFile(process.env.FAKE_AI_RESULT_FILE,JSON.stringify(raw));
 await use(response({response:'OK'},0));
 for(const p of ['claude','codex','gemini'])assert.equal(await verifyProvider(p),'ready');
 for(const[p,raw]of [
 ['claude',response(stream(event,terminal))],
 ['claude',response(terminal)],
 ['codex',response({type:'turn.failed',error:{codexErrorInfo:'usageLimitExceeded',message:'Usage limit reached'}})],
 ['gemini',response({error:{code:429,message:'Quota exceeded',details:[{retryDelay:'120s'}]}})]
 ]){
 await use(raw);
 await assert.rejects(askProvider(p,'quota test'),e=>/한도/.test(e.message)&&/복구/.test(e.message)&&!/로그인/.test(e.message));
 assert.equal(await getProviderState(p),'ready','quota keeps login verified');
 assert.ok((await getQuota(p)).limit,'footer observes failure');
 if (p==='claude') assert.equal((await getQuota(p)).limit.resetsAt,second,'both exhausted windows use the later reset');
 }
 assert.equal(await verifyProvider('gemini'),'ready','quota during login probe is not logout');
 await use(response({error:{code:503,message:'Server overloaded'}}));
 await assert.rejects(verifyProvider('gemini'),/서버 문제/);
 await use(response({type:'result',is_error:true,result:'authentication_failed'}));
 await assert.rejects(askProvider('claude','auth test'),/로그인이 만료/);
 assert.equal(await getProviderState('claude'),'unauthenticated');
 await use(response({type:'result',is_error:false,result:'Quota and authentication are normal topics',usage:{}},0));
 assert.equal(await verifyProvider('claude'),'ready');
 assert.match((await askProvider('claude','success')).answer,/normal topics/);
 assert.equal(observedQuota('claude'),undefined);
 console.log('AI failure regression passed: real CLI path, stdout/exit-0 errors, all providers, quota/auth/billing/network, multiple reset windows, unknown reset, login probe, footer, expiry and success.');
}finally{
 if(!resolve(temp).startsWith(join(resolve(tmpdir()),'mycivil3d-ai-errors-')))throw Error('Unsafe cleanup');
 await rm(temp,{recursive:true,force:true});
}
