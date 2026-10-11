import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,mkdtemp,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {fileURLToPath} from 'node:url';
import {localRunnerConfiguration,runLocalNotificationTick,localNotificationLoop,summarizeNotificationRun,waitForNextRun,replaceLocalRunnerStatus,
 type TickResult} from '../src/server/local-notification-runner.ts';
const key='sb_secret_'+'a'.repeat(40),env={APP_URL:'http://localhost:4000',NEXT_PUBLIC_SUPABASE_URL:'https://development.example.test',SUPABASE_SERVICE_ROLE_KEY:key};
const metrics={due_lag_seconds:0,outbox_lag_seconds:0,pending_jobs:0,failed_jobs:0,cleaned_limit_windows:0,alert:false};
const id='10000000-0000-4000-8000-000000000001',lease='20000000-0000-4000-8000-000000000001';
const idle:TickResult={status:'PASS',summary:summarizeNotificationRun({seeded:0,jobs:[],metrics,duration_ms:0})};

test('local activation refuses production/alternate origins, public credentials and configured mail before transport',()=>{
 for(const patch of [{APP_URL:'http://localhost:3000'}, {APP_URL:'https://app.example.test'},
  {APP_URL:'http://localhost:4000/?x=1'},{APP_URL:'http://user@localhost:4000'},
  {NEXT_PUBLIC_SUPABASE_URL:'http://localhost:54321'}, {NEXT_PUBLIC_SUPABASE_URL:'https://key@project.example.test'},
  {NEXT_PUBLIC_SUPABASE_URL:'https://project.example.test/path'}, {NEXT_PUBLIC_SUPABASE_URL:'https://project.example.test/?key=x'},
  {SUPABASE_SERVICE_ROLE_KEY:'sb_publishable_public'}, {SUPABASE_SERVICE_ROLE_KEY:'bad'},
  {INVITATION_MAIL_URL:'https://mail.example.test'}, {INVITATION_MAIL_TOKEN:'secret'}]){
  assert.throws(()=>localRunnerConfiguration({...env,...patch}),/^Error: LOCAL_RUNNER_CONFIGURATION_INVALID$/);
 }
 const jwt=(role:string)=>'header.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
 assert.throws(()=>localRunnerConfiguration({...env,SUPABASE_SERVICE_ROLE_KEY:jwt('authenticated')}));
 assert.doesNotThrow(()=>localRunnerConfiguration({...env,SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')}));
 assert.equal(localRunnerConfiguration(env).base.href,env.NEXT_PUBLIC_SUPABASE_URL+'/');
});

test('real orchestrator performs only bounded private worker RPCs; report drops job/lease/customer identifiers',async()=>{
 const names:string[]=[];let claims=0;
 const result=await runLocalNotificationTick(env,new AbortController().signal,async(input,init)=>{
  const url=new URL(String(input)),name=url.pathname.split('/').at(-1)!;names.push(name);
  assert.equal(url.origin,env.NEXT_PUBLIC_SUPABASE_URL);assert.equal(init?.method,'POST');
  assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.ok(init?.signal);
  assert.equal(new Headers(init?.headers).get('apikey'),key);assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+key);
  const args=JSON.parse(String(init?.body));
  if(name==='worker_seed_due'){assert.deepEqual(args,{p_limit:100});return Response.json({seeded:1});}
  if(name==='worker_claim_notifications'){assert.deepEqual(args,{p_limit:1});return Response.json(claims++?[]:[{id,lease_token:lease,event_type:'FOLLOW_UP_DUE'}]);}
  if(name==='worker_finish_notification'){assert.deepEqual(args,{p_job:id,p_lease:lease});return Response.json({state:'SUCCEEDED',written:1});}
  assert.equal(name,'worker_notification_metrics');return Response.json(metrics);
 });
 assert.equal(result.status,'PASS');if(result.status==='PASS'){
  assert.equal(result.summary.notifications_written,1);assert.equal(result.summary.succeeded,1);
 }
 assert.deepEqual(names,['worker_seed_due','worker_claim_notifications','worker_finish_notification','worker_claim_notifications','worker_notification_metrics']);
 assert.doesNotMatch(JSON.stringify(result),new RegExp(id+'|'+lease+'|'+key+'|development.example'));
});

test('notification queue mail jobs remain link-only; even ambient mail configuration cannot dispatch',async()=>{
 let claims=0;const names:string[]=[];const saved=process.env.INVITATION_MAIL_URL;process.env.INVITATION_MAIL_URL='https://mail.example.test';
 try{
  const result=await runLocalNotificationTick(env,new AbortController().signal,async(input,init)=>{
   const name=new URL(String(input)).pathname.split('/').at(-1)!;names.push(name);
   if(name==='worker_seed_due')return Response.json({seeded:0});
   if(name==='worker_claim_notifications')return Response.json(claims++?[]:[{id,lease_token:lease,event_type:'INVITATION_MAIL'}]);
   if(name==='worker_prepare_invitation_mail')return Response.json({available:true,to:'PRIVATE@example.test',token_hash:'PRIVATE'});
   if(name==='worker_complete_invitation_mail'){assert.equal(JSON.parse(String(init?.body)).p_result,'LINK_ONLY');return Response.json({state:'CANCELLED',written:0});}
   assert.equal(name,'worker_notification_metrics');return Response.json(metrics);
  });
  assert.equal(result.status,'PASS');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|mail.example/);
  assert.equal(names.includes('worker_complete_invitation_mail'),true);
 }finally{if(saved===undefined)delete process.env.INVITATION_MAIL_URL;else process.env.INVITATION_MAIL_URL=saved;}
});

test('upstream failures, oversized private bodies and invalid result shapes are sanitized',async()=>{
 for(const response of [()=>Response.json({message:'PRIVATE_SECRET'}, {status:401}),
  ()=>new Response('PRIVATE '+ 'x'.repeat(33000),{status:500}),()=>Response.json({seeded:-1}),
  ()=>new Response('PRIVATE HTML',{status:200}),()=>{throw Error('PRIVATE_NETWORK_TOKEN');}]){
  const result=await runLocalNotificationTick(env,new AbortController().signal,async(input)=>{
   const name=new URL(String(input)).pathname.split('/').at(-1);
   if(name==='worker_seed_due')return response();if(name==='worker_claim_notifications')return Response.json([]);return Response.json(metrics);
  });
  assert.deepEqual(result,{status:'UNAVAILABLE',reason:'WORKER_RUN_NOT_VERIFIED'});
 }
});

test('report rejects unexpected fields, excessive jobs, inconsistent metrics and unsafe publication counts',()=>{
 const base={seeded:0,jobs:[],metrics,duration_ms:0};
 for(const bad of [{...base,private:'SECRET'}, {...base,metrics:{...metrics,secret:'SECRET'}},
  {...base,metrics:{...metrics,failed_jobs:1}}, {...base,seeded:101}, {...base,duration_ms:-1},
  {...base,jobs:Array.from({length:21},()=>({id,state:'SUCCEEDED',written:1}))},
  {...base,jobs:[{id,state:'SUCCEEDED',written:101}]}, {...base,jobs:[{id,state:'UNKNOWN',written:1}]}])assert.throws(()=>summarizeNotificationRun(bad));
});

test('stop aborts before privileged network calls and bounded runs do not masquerade as success',async()=>{
 const control=new AbortController();control.abort();let calls=0;
 const result=await runLocalNotificationTick(env,control.signal,async()=>{calls++;throw Error('UNREACHABLE');});
 assert.equal(calls,0);assert.equal(result.status,'UNAVAILABLE');
 const waiting=new AbortController();const wait=waitForNextRun(60_000,waiting.signal);waiting.abort();await assert.rejects(wait,/STOPPED/);
 await assert.rejects(waitForNextRun(60_000,waiting.signal),/STOPPED/);
});

test('automatic cadence is measured between starts; slow runs never overlap or burst catch-up',async()=>{
 const control=new AbortController();let now=0,active=0,peak=0;const delays:number[]=[],starts:number[]=[];
 await localNotificationLoop({signal:control.signal,clock:()=>now,tick:async()=>{
  active++;peak=Math.max(peak,active);starts.push(now);now+=starts.length===1?2500:65_000;active--;return idle;
 },record:async()=>{},wait:async delay=>{delays.push(delay);now+=delay;if(delays.length===3)control.abort();}});
 assert.equal(peak,1);assert.deepEqual(starts,[0,60_000,185_000]);assert.deepEqual(delays,[57_500,60_000,60_000]);
});

test('transient tick failure is recorded safely and later scheduled runs recover',async()=>{
 const control=new AbortController();let ticks=0;const records:TickResult[]=[];
 await localNotificationLoop({signal:control.signal,clock:()=>0,tick:async()=>{if(++ticks===1)throw Error('PRIVATE');return idle;},
  record:async value=>{records.push(value);},wait:async()=>{if(ticks===2)control.abort();}});
 assert.deepEqual(records,[{status:'UNAVAILABLE',reason:'WORKER_RUN_NOT_VERIFIED'},idle]);
});

test('stop during an in-flight run suppresses late evidence and skips any next run',async()=>{
 const control=new AbortController();let recorded=0,waited=0;
 await localNotificationLoop({signal:control.signal,tick:async()=>{control.abort();return idle;},
  record:async()=>{recorded++;},wait:async()=>{waited++;}});
 assert.equal(recorded,0);assert.equal(waited,0);
});

test('status persistence failure stops the loop instead of silently scheduling unrecorded mutations',async()=>{
 let calls=0;
 await assert.rejects(localNotificationLoop({signal:new AbortController().signal,tick:async()=>{calls++;return idle;},
  record:async()=>{throw Error('DISK_FULL');},wait:async()=>{throw Error('SHOULD_NOT_WAIT');}}),/DISK_FULL/);
 assert.equal(calls,1);
});
test('Transient status replacement retries the same file without repeating a recorded worker tick',async()=>{
 const signal=new AbortController(),temp=new URL('file:///synthetic/status.tmp'),target=new URL('file:///synthetic/status.json');let calls=0,records=0,replaces=0;const pauses:number[]=[];
 await localNotificationLoop({signal:signal.signal,tick:async()=>{calls++;return idle;},record:async()=>{records++;await replaceLocalRunnerStatus(temp,target,{replace:async(from,to)=>{assert.equal(from,temp);assert.equal(to,target);if(++replaces<3)throw Object.assign(Error('Transient sharing failure'),{code:replaces===1?'EPERM':'EBUSY'});},pause:async ms=>{pauses.push(ms);}});},wait:async()=>{signal.abort();}});
 assert.equal(calls,1);assert.equal(records,1);assert.equal(replaces,3);assert.deepEqual(pauses,[50,100]);
});
test('Persistent status sharing failure stays bounded and fails closed before another worker run',async()=>{
 const temp=new URL('file:///synthetic/status.tmp'),target=new URL('file:///synthetic/status.json'),failure=Object.assign(Error('Sharing failure'),{code:'EACCES'});let calls=0,replaces=0,waits=0;const pauses:number[]=[];
 await assert.rejects(localNotificationLoop({signal:new AbortController().signal,tick:async()=>{calls++;return idle;},record:async()=>replaceLocalRunnerStatus(temp,target,{replace:async()=>{replaces++;throw failure;},pause:async ms=>{pauses.push(ms);}}),wait:async()=>{waits++;}}),error=>error===failure);
 assert.equal(calls,1);assert.equal(replaces,5);assert.equal(waits,0);assert.deepEqual(pauses,[50,100,200,400]);
});
test('Nontransient status disk failure is not retried or reported as a successful publication',async()=>{
 const failure=Object.assign(Error('Disk failure'),{code:'ENOSPC'});let replaces=0;
 await assert.rejects(replaceLocalRunnerStatus(new URL('file:///synthetic/status.tmp'),new URL('file:///synthetic/status.json'),{replace:async()=>{replaces++;throw failure;},pause:async()=>assert.fail('No retry expected')}),error=>error===failure);assert.equal(replaces,1);
});

test('CLI requires explicit activation and help/invalid arguments do not read development configuration',()=>{
 const script=fileURLToPath(new URL('../scripts/run-local-notifications.mjs',import.meta.url));
 for(const [args,status] of [[['--help'],0],[[],2],[['--start','--stop'],2],[['--interval','1'],2]] as const){
  const run=spawnSync(process.execPath,['--experimental-strip-types',script,...args],{encoding:'utf8',windowsHide:true});
  assert.equal(run.status,status);assert.doesNotMatch(run.stdout+run.stderr,new RegExp(key+'|SUPABASE_SERVICE_ROLE_KEY=|Bearer '));
 }
});

test('actual CLI enforces one owner, publishes safe status and stops cooperatively without killing another process',async()=>{
 const temporary=await mkdtemp(join(tmpdir(),'leadpilot-local-runner-'));
 const scripts=join(temporary,'backend','scripts'),cache=join(temporary,'backend','.cache');
 let child:ReturnType<typeof spawn>|undefined;
 try{
  await mkdir(scripts,{recursive:true});await mkdir(join(temporary,'frontend'));
  await writeFile(join(temporary,'frontend','.env.local'),'APP_URL=http://localhost:4000\n');
  const runnerURL=new URL('../src/server/local-notification-runner.ts',import.meta.url).href;
  // Inject only the tick/config dependencies: exercise the shipped CLI lock/files/process controls.
  const stub=join(scripts,'tick.mjs');await writeFile(stub,`export {localNotificationLoop,LOCAL_INTERVAL_MS,replaceLocalRunnerStatus} from ${JSON.stringify(runnerURL)};
export const localRunnerConfiguration=()=>({});
export const runLocalNotificationTick=async()=>(${JSON.stringify(idle)});`);
  const original=await readFile(new URL('../scripts/run-local-notifications.mjs',import.meta.url),'utf8');
  const script=join(scripts,'runner.mjs');await writeFile(script,original
   .replace("'./local-evidence.mjs'",JSON.stringify(new URL('../scripts/local-evidence.mjs',import.meta.url).href))
   .replace("'../src/server/local-notification-runner.ts'",JSON.stringify(pathToFileURL(stub).href)));
  child=spawn(process.execPath,['--experimental-strip-types',script,'--start'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let diagnostic='';child.stdout?.on('data',value=>{diagnostic+=value;});child.stderr?.on('data',value=>{diagnostic+=value;});
  const closed=new Promise<number|null>(resolveClose=>child!.once('close',resolveClose));
  const until=async(check:()=>Promise<boolean>)=>{
   const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,50));}throw Error('CLI_TEST_TIMEOUT');
  };
  await until(async()=>{if(child?.exitCode!==null)throw Error('CLI_TEST_EARLY_EXIT: '+diagnostic);try{return JSON.parse(await readFile(join(cache,'local-notifications.json'),'utf8')).runs===1;}catch{return false;}});
  const owner=JSON.parse(await readFile(join(cache,'local-notifications.lock'),'utf8'));
  assert.equal(owner.pid,child.pid);assert.equal(child.exitCode,null);process.kill(owner.pid,0);
  const duplicate=spawnSync(process.execPath,['--experimental-strip-types',script,'--start'],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(duplicate.status,2);assert.match(duplicate.stderr,/Runner lock exists/);
  const status=spawnSync(process.execPath,['--experimental-strip-types',script,'--status'],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(JSON.parse(status.stdout).running,true);assert.equal(JSON.parse(status.stdout).last_run.runs,1);
  const stopping=spawnSync(process.execPath,['--experimental-strip-types',script,'--stop'],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(stopping.status,0);assert.match(stopping.stdout,/Graceful stop requested/);
  await until(async()=>child?.exitCode!==null);assert.equal(await closed,0);
  assert.equal(JSON.parse(await readFile(join(cache,'local-notifications.json'),'utf8')).state,'STOPPED');
  await assert.rejects(access(join(cache,'local-notifications.lock')));
  await assert.rejects(access(join(cache,'local-notifications.stop')));
 }finally{
  if(child&&child.exitCode===null){const stopped=new Promise(resolve=>child!.once('close',resolve));child.kill('SIGKILL');await stopped;}
  // Verify the exact generated test directory remains directly within the named temp root.
  const target=resolve(temporary);assert.equal(dirname(target),resolve(tmpdir()));assert.ok(basename(target).startsWith('leadpilot-local-runner-'));
  await rm(target,{recursive:true,force:true});
 }
});
