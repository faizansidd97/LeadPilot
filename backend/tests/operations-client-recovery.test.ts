import {test} from 'node:test';
import assert from 'node:assert/strict';
import {verifyOperationsSnapshot,analysisUsageSchema} from '../src/domain/operations-progress.ts';
import {operationsWorkflow,usageWorkflow} from '../../frontend/src/lib/operations-workflow.ts';
import {localDatabase,identity,rpc,seedPrivacyFixture} from './helpers/local-db.ts';
const tenant=crypto.randomUUID();
const snapshot=()=>({captured_at:new Date().toISOString(),lag_alert_seconds:900,reminders:{awaiting_creation:0,oldest_due_seconds:0},notifications:{pending:0,running:0,failed:0,expired_leases:0,oldest_pending_seconds:0},ai:{queued:0,running:0,failed:0,expired_leases:0,oldest_pending_seconds:0,reconciliation:0},alerts:[],cost_amount:null,scheduler_verified:false});
const usage=()=>({daily_limit:null,monthly_limit:10,daily_operations:0,monthly_operations:1,reconciliation:0});
const deferred=()=>{let resolve!:(value:unknown)=>void,reject!:(reason:unknown)=>void;return {promise:new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;}),resolve,reject};};
const failure=(status=503)=>Object.assign(Error('Synthetic unavailable'),{status});
test('Operations contracts reject mismatched, duplicate or omitted alerts, impossible ages and expired lease counts',()=>{
 const s=snapshot();assert.deepEqual(verifyOperationsSnapshot(s),s);
 for(const change of [{alerts:['FAILED_AI_JOBS']},{alerts:['FAILED_AI_JOBS','FAILED_AI_JOBS'],ai:{...s.ai,failed:1}},{ai:{...s.ai,failed:1}},{notifications:{...s.notifications,expired_leases:1},alerts:['EXPIRED_WORKER_LEASES']},{reminders:{...s.reminders,oldest_due_seconds:1}},{ai:{...s.ai,oldest_pending_seconds:1}},{notifications:{...s.notifications,oldest_pending_seconds:1}},{private_error:'secret'},{scheduler_verified:true},{cost_amount:0}])assert.throws(()=>verifyOperationsSnapshot({...s,...change}));
 assert.equal(verifyOperationsSnapshot({...s,notifications:{...s.notifications,running:1,oldest_pending_seconds:900}}).alerts.length,0);
 assert.deepEqual(verifyOperationsSnapshot({...s,notifications:{...s.notifications,running:1,oldest_pending_seconds:901},alerts:['NOTIFICATION_QUEUE_DELAYED']}).alerts,['NOTIFICATION_QUEUE_DELAYED']);
});
test('Usage projects only safe counters and nullable configured limits without assuming historical counts fit current caps',()=>{
 assert.deepEqual(analysisUsageSchema.parse({...usage(),customer:'private'}),usage());
 assert.equal(analysisUsageSchema.parse({...usage(),daily_limit:0,daily_operations:4,monthly_operations:2,reconciliation:8}).reconciliation,8);
 for(const change of [{daily_limit:-1},{monthly_limit:1000001},{daily_operations:1.5},{monthly_operations:Number.MAX_SAFE_INTEGER+1},{reconciliation:-1},{monthly_operations:'1'},{daily_limit:undefined}])assert.equal(analysisUsageSchema.safeParse({...usage(),...change}).success,false);
});
for(const [name,factory,data] of [['Operations',operationsWorkflow,snapshot],['Usage',usageWorkflow,usage]] as const){
 test(`${name} masks previous data during refresh and failed reads, then distinguishes confirmed zero from unavailable`,async()=>{
  const wait=deferred();let reads=0;
  const flow=factory(tenant,async()=>++reads===1?data():reads===2?wait.promise:data(),()=>{});
  await flow.refresh();assert.equal(flow.state.loaded,true);const refresh=flow.refresh();assert.equal(flow.state.data,null);assert.equal(flow.state.loaded,false);assert.equal(flow.state.busy,true);wait.reject(failure());assert.equal(await refresh,false);assert.equal(flow.state.data,null);assert.equal(flow.state.loaded,false);assert.ok(flow.state.error);await flow.refresh();assert.equal(flow.state.loaded,true);assert.equal(flow.state.error,'');
 });
 test(`${name} synchronously gates repeated manual and poll reads using GET-only tenant-bound cancellation`,async()=>{
  const wait=deferred();let reads=0;let signal:AbortSignal|undefined;
  const flow=factory(tenant,async(path,options,scope)=>{reads++;assert.equal(scope,tenant);assert.equal(options.method,undefined);assert.equal(options.body,undefined);assert.ok(path.startsWith('/api/v1/agency/'));signal=options.signal as AbortSignal;return wait.promise;},()=>{});
  const first=flow.refresh();assert.equal(await flow.refresh(),false);assert.equal(await flow.refresh(),false);assert.equal(reads,1);assert.equal(signal?.aborted,false);wait.resolve(data());await first;assert.equal(flow.state.busy,false);
 });
 test(`${name} closes and reopens without old response publication or callback despite ignored abort`,async()=>{
  const wait=deferred();let reads=0,changes=0;let oldSignal:AbortSignal|undefined;
  const flow=factory(tenant,async(_path,options)=>{if(++reads===1){oldSignal=options.signal as AbortSignal;return wait.promise;}return data();},()=>changes++);
  const first=flow.refresh();flow.close();assert.equal(oldSignal?.aborted,true);assert.equal(flow.state.data,null);assert.equal(await flow.refresh(),false);flow.activate();await flow.refresh();const count=changes,current=flow.state.data;wait.resolve({...data(),reconciliation:99});assert.equal(await first,false);assert.equal(changes,count);assert.deepEqual(flow.state.data,current);
 });
 test(`${name} ignores late rejected reads after closing and clears all protected data on denial`,async()=>{
  const wait=deferred();let changes=0;
  const old=factory(tenant,async()=>wait.promise,()=>changes++);const first=old.refresh();old.close();const count=changes;wait.reject(failure(403));await first;assert.equal(changes,count);assert.equal(old.state.denied,false);
  for(const status of [401,403,404]){let reads=0;const flow=factory(tenant,async()=>{if(++reads===1)return data();throw failure(status);},()=>{});await flow.refresh();await flow.refresh();assert.equal(flow.state.denied,true);assert.equal(flow.state.data,null);assert.equal(await flow.refresh(),false);assert.equal(reads,2);}
 });
 test(`${name} malformed responses never publish a snapshot or expose contract payload in errors`,async()=>{
  const flow=factory(tenant,async()=>({private_text:'Do not expose',...data(),reconciliation:-1,ai:{queued:'PRIVATE'}}),()=>{});await flow.refresh();assert.equal(flow.state.loaded,false);assert.equal(flow.state.data,null);assert.match(flow.state.error,/could not be verified/);assert.ok(!flow.state.error.includes('PRIVATE'));assert.ok(!flow.state.error.includes('Do not expose'));
 });
}
test('Separate agency read scopes cannot republish old data into the new workflow',async()=>{
 const wait=deferred(),old=operationsWorkflow(tenant,async()=>wait.promise,()=>{});const pending=old.refresh();old.close();const other=crypto.randomUUID(),current=operationsWorkflow(other,async(_p,_o,scope)=>{assert.equal(scope,other);return snapshot();},()=>{});await current.refresh();wait.resolve({...snapshot(),ai:{...snapshot().ai,failed:1},alerts:['FAILED_AI_JOBS']});await pending;assert.equal(old.state.data,null);assert.deepEqual(current.state.data?.alerts,[]);
});
test('Actual SQL Operations/usage client recovery preserves tenant/current manager and owner permissions and never mutates queues or usage',async()=>{
 const db=await localDatabase();try{
  const f=await seedPrivacyFixture(db);await db.exec('reset role');
  await db.query("update public.agencies set ai_daily_limit=2,ai_monthly_limit=3 where id=$1",[f.agency.id]);
  await db.query("insert into private.ai_usage_windows values($1,'DAY',(now() at time zone 'UTC')::date,4),($1,'MONTH',date_trunc('month',now() at time zone 'UTC')::date,8),($2,'DAY',(now() at time zone 'UTC')::date,999)",[f.agency.id,f.foreign.id]);
  const stateSql="select (select jsonb_agg(to_jsonb(o) order by id) from private.outbox_events o) outbox,(select jsonb_agg(to_jsonb(j) order by id) from public.ai_jobs j) jobs,(select jsonb_agg(to_jsonb(w) order by tenant_id,kind,period_at) from private.ai_usage_windows w) usage,(select count(*) from public.activity_events)::int audits,(select count(*) from private.api_requests)::int receipts";
  const before=(await db.query(stateSql)).rows[0];let unavailable=false;
  const read=async(path:string,options:RequestInit,scope:string)=>{assert.equal(options.method,undefined);assert.equal(options.body,undefined);if(unavailable)throw failure();try{return await rpc(db,path.endsWith('operations')?'agency_operations_snapshot':'analysis_usage',[scope]);}catch(error){throw Object.assign(error as Error,{status:403});}};
  await identity(db,f.owner);const ops=operationsWorkflow(f.agency.id,read,()=>{}),owner=usageWorkflow(f.agency.id,read,()=>{});
  assert.equal(await ops.refresh(),true);assert.equal(await owner.refresh(),true);assert.equal(owner.state.data?.daily_operations,4);assert.equal(owner.state.data?.monthly_operations,8);
  unavailable=true;await ops.refresh();await owner.refresh();assert.equal(ops.state.data,null);assert.equal(owner.state.data,null);unavailable=false;await ops.refresh();await owner.refresh();
  await identity(db,f.admin);assert.equal(await ops.refresh(),true);assert.equal(await owner.refresh(),false);assert.equal(owner.state.denied,true);
  await identity(db,f.agent);await ops.refresh();assert.equal(ops.state.denied,true);assert.equal(ops.state.data,null);
  await identity(db,f.owner);const foreign=operationsWorkflow(f.foreign.id,read,()=>{});await foreign.refresh();assert.equal(foreign.state.denied,true);
  await db.exec('reset role');await db.query('update public.memberships set active=false where tenant_id=$1 and user_id=$2',[f.agency.id,f.owner]);await identity(db,f.owner);
  const disabled=usageWorkflow(f.agency.id,read,()=>{});await disabled.refresh();assert.equal(disabled.state.denied,true);
  await db.exec('reset role');assert.deepEqual((await db.query(stateSql)).rows[0],before);
 }finally{await db.close();}
});
