import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase,identity,rpc,seedPrivacyFixture,migrationDir} from './helpers/local-db.ts';
import {platformHealthSchema,platformHealthAlerts} from '../src/domain/platform-health.ts';

test('platform health has current statement metrics, private aggregate permissions and read-only recovery',async t=>{
 let db=await localDatabase();try{
 const f=await seedPrivacyFixture(db);await db.exec('reset role;delete from private.outbox_events');
 const health=async()=>{await db.exec('reset role;set role service_role');return platformHealthSchema.parse(await rpc(db,'worker_health_snapshot'));};
 await t.test('empty platform has a real fresh snapshot and no false scheduler, billing or privacy claims',async()=>{
  const h=await health();assert.equal(h.alert,false);assert.equal(h.outbox_pending,0);assert.equal(h.ai_pending,0);
  assert.equal(h.scheduler_verified,false);assert.equal(h.cost_amount,null);assert.equal(h.privacy_execution_available,false);
  assert.ok(Math.abs(Date.now()-Date.parse(h.captured_at))<5000);
 });
 await db.exec('reset role');
 for(const [tenant,lead,actor] of [[f.agency.id,f.lead.id,f.owner],[f.foreign.id,f.foreignLead.id,f.other]]){
  const member=(await db.query<any>('select id from public.memberships where tenant_id=$1 and user_id=$2',[tenant,actor])).rows[0].id;
  for(const [index,state] of ['RUNNING','RUNNING','FAILED'].entries()){
   const id=crypto.randomUUID();
   await db.query(`insert into private.outbox_events(id,tenant_id,event_type,entity_id,dedupe_key,payload,state,attempts,created_at,lease_token,lease_until)
    values($1::uuid,$2,'INVITATION_MAIL',$3,($1::uuid)::text,'{"private":"PRIVATE_CUSTOMER"}',$4,1,now(),$5,$6)`,
    [id,tenant,lead,state,state==='RUNNING'?crypto.randomUUID():null,state==='RUNNING'?new Date(Date.now()+(index===0?-5000:60000)).toISOString():null]);
   await db.query(`insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,state,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at,kind,lease_token,lease_until,usage_state,observed_tokens)
    values($1,$2,$3,$4,$5,$6,'PRIVATE_MODEL','fixture','fixture',1,date_trunc('month',now() at time zone 'UTC')::date,(now() at time zone 'UTC')::date,$7,$8,$9,$10,17)`,
    [tenant,lead,member,actor,state,index+1,index===0?'ANALYSIS':'DRAFT',state==='RUNNING'?crypto.randomUUID():null,state==='RUNNING'?new Date(Date.now()+(index===0?-5000:60000)).toISOString():null,state==='FAILED'?'RECONCILE':'RESERVED']);
  }
 }
 await t.test('counts aggregate two agencies, both AI kinds and only expired running leases',async()=>{
  const h=await health();assert.equal(h.outbox_pending,4);assert.equal(h.ai_pending,4);assert.equal(h.outbox_expired_leases,2);assert.equal(h.ai_expired_leases,2);
  assert.equal(h.outbox_failed,2);assert.equal(h.ai_failed,2);assert.equal(h.reconcile_operations,2);assert.equal(h.reserved_operations,4);assert.equal(h.observed_tokens_month,102);
  assert.ok(platformHealthAlerts(h).includes('EXPIRED_WORKER_LEASES'));assert.equal(h.alert,true);
  for(const forbidden of [f.owner,f.agency.id,f.lead.id,'PRIVATE','example.test'])assert.ok(!JSON.stringify(h).includes(forbidden));
 });
 await t.test('global metrics are denied to every cookie role, anon and direct table access',async()=>{
  for(const actor of [f.owner,f.admin,f.agent,f.other]){await identity(db,actor,true);await assert.rejects(()=>rpc(db,'worker_health_snapshot'),/permission denied/);}
  await db.exec('reset role;set role anon');await assert.rejects(()=>rpc(db,'worker_health_snapshot'),/permission denied/);
  await assert.rejects(()=>db.exec('select * from private.outbox_events'),/permission denied/);
 });
 await t.test('repeated health reads preserve queue payloads, leases, reservations, notices, audit and receipts',async()=>{
  const state=async()=>{await db.exec('reset role');return (await db.query<any>(`select
   (select jsonb_agg(to_jsonb(o) order by id) from private.outbox_events o) outbox,
   (select jsonb_agg(to_jsonb(j) order by id) from public.ai_jobs j) ai,
   (select jsonb_agg(to_jsonb(w)) from private.ai_usage_windows w) usage,
   (select count(*) from public.activity_events) audits,(select count(*) from private.api_requests) receipts,
   (select count(*) from public.notifications) notices,(select count(*) from private.request_limits) rate_windows`)).rows[0];};
  const before=await state();await health();await health();assert.deepEqual(await state(),before);
 });
 await t.test('expired leases alone alert even below lag threshold, without claiming or retrying work',async()=>{
  await db.exec(`reset role;update private.outbox_events set state='SUCCEEDED',lease_token=null,lease_until=null where state='FAILED';
   update public.ai_jobs set state='SUCCEEDED',usage_state='CONSUMED',lease_token=null,lease_until=null where state='FAILED';`);
  const h=await health();assert.ok(h.outbox_lag_seconds<900);assert.ok(h.ai_lag_seconds<900);
  assert.deepEqual(platformHealthAlerts(h),['EXPIRED_WORKER_LEASES']);assert.equal(h.alert,true);
 });
 await t.test('newly due tasks and expired leases use statement time within an older transaction',async()=>{
  await db.exec('reset role;begin');
  await new Promise(resolve=>setTimeout(resolve,1500));
  const task=(await db.query<any>("insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,due_at,created_by) values($1,$2,$3,'INTERNAL','PRIVATE_DUE',now()+interval '100 milliseconds',$4) returning id",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner])).rows[0].id;
  await db.query("update private.outbox_events set lease_until=now()+interval '100 milliseconds' where state='RUNNING'");
  await db.exec('set role service_role');const h=platformHealthSchema.parse(await rpc(db,'worker_health_snapshot'));
  assert.ok(h.due_lag_seconds>=1);assert.equal(h.outbox_expired_leases,4);
  await db.exec('reset role');assert.equal((await db.query<any>('select due_at>now() future_for_transaction from public.follow_ups where id=$1',[task])).rows[0].future_for_transaction,true);
  await db.exec('rollback');
 });
 await t.test('eligible reminders exclude archive, contact blocks, unverified/deactivated recipients and emitted notices',async()=>{
  await db.exec('reset role');
  const task=(await db.query<any>("insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,due_at,created_by) values($1,$2,$3,'CALL','PRIVATE_DUE',now()-interval '30 minutes',$4) returning id",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner])).rows[0].id;
  assert.ok((await health()).due_lag_seconds>=1800);
  for(const column of ['archived_at=now()','do_not_contact=true']){
   await db.exec('reset role');await db.query('update public.leads set '+column+' where id=$1',[f.lead.id]);assert.equal((await health()).due_lag_seconds,0);
   await db.exec('reset role');await db.query('update public.leads set archived_at=null,do_not_contact=false where id=$1',[f.lead.id]);
  }
  await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=null where id=$1',[f.agent]);assert.equal((await health()).due_lag_seconds,0);
  await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=now() where id=$1',[f.agent]);await db.query('update public.memberships set active=false where id=$1',[f.members[f.agent+f.agency.id]]);assert.equal((await health()).due_lag_seconds,0);
  await db.exec('reset role');await db.query('update public.memberships set active=true where id=$1',[f.members[f.agent+f.agency.id]]);
  await db.query("insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,task_id,schedule_version,dedupe_key) values($1,$2,'FOLLOW_UP_DUE',$3,$4,$3,1,$5)",[f.agency.id,f.members[f.agent+f.agency.id],task,f.lead.id,'due:'+task+':1']);
  assert.equal((await health()).due_lag_seconds,0);
 });
 await t.test('actual dump/load preserves health aggregate and global service-only permissions',async()=>{
  const before=await health();await db.exec('reset role');const dump=await db.dumpDataDir('none');await db.close();db=new PGlite({loadDataDir:dump});
  const restored=await health();for(const key of ['outbox_expired_leases','ai_expired_leases','outbox_pending','ai_pending','alert'] as const)assert.equal(restored[key],before[key]);
  await identity(db,f.owner,true);await assert.rejects(()=>rpc(db,'worker_health_snapshot'),/permission denied/);
 });
 }finally{await db.close();}
});

test('health migration failure restores original function and permissions, then upgrades successfully',async()=>{
 const db=await localDatabase({through:18});try{
  const source=await readFile(new URL('202610080019_platform_health.sql',migrationDir),'utf8');
  const definition=async()=>(await db.query<any>("select prosrc body,provolatile volatility,proacl::text acl from pg_proc where oid='public.worker_health_snapshot()'::regprocedure")).rows[0];
  const before=await definition();await assert.rejects(()=>db.exec(source.replace('commit;','select 1/0;\ncommit;')),/division by zero/);await db.exec('rollback');assert.deepEqual(await definition(),before);
  await db.exec('set role service_role');assert.equal((await rpc(db,'worker_health_snapshot')).outbox_expired_leases,undefined);
  await db.exec('reset role');await db.exec(source);assert.equal((await definition()).volatility,'s');await db.exec('set role service_role');assert.ok(platformHealthSchema.safeParse(await rpc(db,'worker_health_snapshot')).success);
  await db.exec('reset role;set role authenticated');await assert.rejects(()=>rpc(db,'worker_health_snapshot'),/permission denied/);
 }finally{await db.close();}
});
