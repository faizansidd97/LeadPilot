import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {platformHealthSchema,platformHealthAlerts, type PlatformHealth} from '../src/domain/platform-health.ts';
import {readPlatformHealth} from '../src/server/health-read.ts';
import {api} from '../src/server/http.ts';
import {checkPlatformHealth} from '../src/server/platform-monitor.ts';
const secret='a'.repeat(64),now=Date.parse('2026-10-08T10:00:00Z');
const env={APP_URL:'https://staging.example.test',CRON_SECRET:secret};
const healthy=():PlatformHealth=>({database:'REACHABLE',captured_at:new Date(now).toISOString(),lag_alert_seconds:900,
 due_lag_seconds:0,outbox_lag_seconds:0,ai_lag_seconds:0,outbox_pending:0,outbox_failed:0,outbox_expired_leases:0,
 ai_pending:0,ai_failed:0,ai_expired_leases:0,reserved_operations:0,reconcile_operations:0,observed_tokens_month:0,
 cost_amount:null,privacy_pending:0,privacy_execution_available:false,scheduler_verified:false,alert:false});
const request=(suffix='',authorization='Bearer '+secret)=>new Request('https://staging.example.test/api/internal/health'+suffix,{headers:{authorization}});
const json=(data:unknown,status=200)=>Response.json(data,{status});

test('platform contract covers all seven fixed alerts and precise lag boundary',()=>{
 const base={...healthy(),due_lag_seconds:900,outbox_pending:1,outbox_lag_seconds:900,ai_pending:1,ai_lag_seconds:900};
 assert.deepEqual(platformHealthAlerts(platformHealthSchema.parse(base)),[]);
 const all={...base,due_lag_seconds:901,outbox_lag_seconds:901,ai_lag_seconds:901,outbox_failed:1,ai_failed:1,
  outbox_expired_leases:1,ai_expired_leases:1,reconcile_operations:1,alert:true};
 assert.equal(platformHealthAlerts(platformHealthSchema.parse(all)).length,7);
 // Privacy review, reservations and observed tokens alone are not worker failure or billing evidence.
 assert.equal(platformHealthSchema.parse({...healthy(),privacy_pending:3,reserved_operations:5,observed_tokens_month:99}).alert,false);
});
test('contract refuses private fields, invalid counts, inconsistent alerts and unsupported claims',()=>{
 for(const value of [{...healthy(),payload:'PRIVATE'}, {...healthy(),database:'DOWN'}, {...healthy(),outbox_failed:-1},
  {...healthy(),ai_failed:0.5}, {...healthy(),ai_pending:Number.MAX_SAFE_INTEGER+1}, {...healthy(),alert:true},
  {...healthy(),ai_expired_leases:1}, {...healthy(),outbox_pending:1,outbox_expired_leases:2,alert:true},
  {...healthy(),outbox_lag_seconds:1}, {...healthy(),ai_failed:1}, {...healthy(),scheduler_verified:true},
  {...healthy(),privacy_execution_available:true}, {...healthy(),cost_amount:1}, {...healthy(),captured_at:'invalid'}]) {
  assert.equal(platformHealthSchema.safeParse(value).success,false);
 }
});
test('health read denies bearer/query bypasses before loading database and preserves private response headers',async()=>{
 for(const [req,key,status] of [[request('',''),secret,401],[request('','Bearer wrong'),secret,401],
  [request('?token='+secret,''),secret,401],[request('?tenant_id=anything'),secret,422],[request(),undefined,503]] as const){
  let called=0;const response=await api(()=>readPlatformHealth(req,key,async()=>{called++;return {data:healthy(),error:null};}));
  assert.equal(response.status,status);assert.equal(called,0);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.doesNotMatch(await response.text(),new RegExp(secret));
 }
 const response=await api(()=>readPlatformHealth(request(),secret,async()=>({data:healthy(),error:null})));
 assert.equal(response.status,200);assert.deepEqual((await response.json()).data,healthy());
});
test('health read fails closed for database/schema failures without reflecting private diagnostics',async()=>{
 for(const load of [async()=>({data:{...healthy(),payload:'PRIVATE'},error:null}),
  async()=>({data:null,error:{message:'PRIVATE_DATABASE_TEXT'}}),async()=>{throw Error('PRIVATE_EXCEPTION');}]){
  const response=await api(()=>readPlatformHealth(request(),secret,load));assert.equal(response.status,503);
  assert.doesNotMatch(await response.text(),/PRIVATE|payload|Zod/);
 }
});
test('operator monitor is one minimized read using only the cron bearer, with fresh healthy and attention outcomes',async()=>{
 for(const h of [healthy(),{...healthy(),ai_pending:1,ai_expired_leases:1,alert:true}]){
  let calls=0;
  const report=await checkPlatformHealth({...env,SUPABASE_SERVICE_ROLE_KEY:'PRIVATE'},async(input,init)=>{
   calls++;const url=new URL(String(input));assert.equal(url.href,env.APP_URL+'/api/internal/health');
   assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.ok(init?.signal);
   assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+secret);assert.equal(new Headers(init?.headers).get('apikey'),null);
   return json({data:h});
  },()=>now);
  assert.equal(calls,1);assert.equal(report.status,h.alert?'ATTENTION':'NO_ALERTS');assert.equal(report.scheduler_verified,false);assert.equal(report.release_accepted,false);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE|example.test|Bearer/);
  if('alerts' in report)assert.deepEqual(report.alerts,h.alert?['EXPIRED_WORKER_LEASES']:[]);
 }
});
test('monitor rejects invalid staging origins and bearer shapes before transport',async()=>{
 for(const config of [{...env,APP_URL:'http://localhost:4000'}, {...env,APP_URL:'https://localhost'},
  {...env,APP_URL:'https://user:pass@staging.example.test'}, {...env,APP_URL:'https://staging.example.test/path'},
  {...env,APP_URL:env.APP_URL+'?token=PRIVATE'}, {...env,APP_URL:env.APP_URL+'#PRIVATE'},
  {...env,CRON_SECRET:''}, {...env,CRON_SECRET:'short'}, {...env,CRON_SECRET:secret+'\nPRIVATE'}]){
  let called=0;await assert.rejects(checkPlatformHealth(config,async()=>{called++;return json({data:healthy()});}),/INVALID_MONITOR_CONFIGURATION/);
  assert.equal(called,0);
 }
});
test('monitor refuses stale and future snapshots, while exact freshness boundaries pass',async()=>{
 for(const [age,expected] of [[120000,'NO_ALERTS'],[120001,'UNAVAILABLE'],[-30000,'NO_ALERTS'],[-30001,'UNAVAILABLE']] as const){
  const report=await checkPlatformHealth(env,async()=>json({data:{...healthy(),captured_at:new Date(now-age).toISOString()}}),()=>now);
  assert.equal(report.status,expected);
 }
});
test('monitor treats HTTP/redirect/timeout/schema/malformed/oversized failures as unavailable without raw data',async()=>{
 for(const fetcher of [async()=>json({error:'PRIVATE'},503),async()=>json({data:healthy()},401),
  async()=>new Response('PRIVATE_HTML',{headers:{'content-type':'text/html'}}),
  async()=>json({data:healthy(),error:'PRIVATE'}),async()=>json({data:{...healthy(),payload:'PRIVATE'}}),
  async()=>json({data:{...healthy(),outbox_failed:1}}),
  async()=>new Response('PRIVATE'.repeat(3000),{headers:{'content-type':'application/json'}}),
  async()=>new Response('PRIVATE_NOT_JSON',{headers:{'content-type':'application/json'}}),
  async()=>{throw Error('PRIVATE_TIMEOUT_OR_REDIRECT');}]){
  const report=await checkPlatformHealth(env,fetcher,()=>now);assert.equal(report.status,'UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE|snapshot|NO_ALERTS/);
 }
});
test('monitor CLI help/blocked paths read no config and print no secrets',()=>{
 const script=fileURLToPath(new URL('../scripts/check-platform-health.mjs',import.meta.url));
 for(const args of [['--help','--staging-config','MISSING_PRIVATE_FILE'],['--staging-config','MISSING_PRIVATE_FILE'],['--connect-staging']]){
  const result=spawnSync(process.execPath,['--experimental-strip-types',script,...args],{encoding:'utf8',windowsHide:true,
   env:{...process.env,APP_URL:'https://localhost',CRON_SECRET:'PRIVATE_UNSAFE_SECRET'}});
  assert.equal(result.status,args[0]==='--help'?0:2);
  assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_UNSAFE_SECRET|MISSING_PRIVATE_FILE|ENOENT|fetch failed/);
 }
});
