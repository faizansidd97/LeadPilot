import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase,identity,rpc,seedPrivacyFixture,migrationDir} from './helpers/local-db.ts';
import {aiAttemptDiagnosticsSchema} from '../src/domain/ai-attempts.ts';
const req=()=>crypto.randomUUID();

test('AI attempt tracking is atomic, fenced, privately scoped and retained through real recovery',async t=>{
 let db=await localDatabase();try{
 const f=await seedPrivacyFixture(db);
 await db.exec('reset role');await db.query('update public.agencies set ai_enabled=true,processing_approved=true,ai_daily_limit=100,ai_monthly_limit=100 where id=$1',[f.agency.id]);
 const worker=async()=>db.exec('reset role;set role service_role');
 await worker();await rpc(db,'worker_set_ai_policy',[true,'fixture-model',['en'],true,req()]);await rpc(db,'worker_set_draft_policy',[true,req()]);
 const jobs:{id:string;lease:string;request:string;kind:string}[]=[];
 const diagnose=async(job:string)=>{await worker();return aiAttemptDiagnosticsSchema.parse(await rpc(db,'worker_ai_attempt_diagnostics',[job]));};
 for(const kind of ['analysis','draft']){
  await identity(db,f.owner);const job=kind==='analysis'
   ?(await rpc(db,'submit_analysis',[f.agency.id,f.lead.id,f.lead.version,req(),req()])).job_id
   :(await rpc(db,'submit_draft',[f.agency.id,f.lead.id,f.lead.version,{language:'en',tone:'PROFESSIONAL',instruction:''},req(),req()])).job_id;
  await worker();const claim=await rpc(db,'worker_claim_'+kind,[req()]);assert.equal(claim.id,job);
  await t.test(kind+' same-lease prepare retries preserve one ID and one private row',async()=>{
   const first=await rpc(db,'worker_prepare_'+kind,[job,claim.lease_token,req()]);const replay=await rpc(db,'worker_prepare_'+kind,[job,claim.lease_token,req()]);
   assert.equal(replay.provider_request_id,first.provider_request_id);assert.match(first.provider_request_id,/^[a-f0-9-]{36}$/);
   const d=await diagnose(job);assert.equal(d.attempts.length,1);assert.equal(d.claims_without_prepare_record,0);
   jobs.push({id:job,lease:claim.lease_token,request:first.provider_request_id,kind});
  });
  await t.test(kind+' stale/wrong-kind/unknown prepare cannot create another receipt',async()=>{
   assert.equal(await rpc(db,'worker_prepare_'+kind,[job,req(),req()]),null);
   assert.equal(await rpc(db,'worker_prepare_'+(kind==='analysis'?'draft':'analysis'),[job,claim.lease_token,req()]),null);
   assert.equal(await rpc(db,'worker_prepare_'+kind,[req(),claim.lease_token,req()]),null);
   assert.equal((await diagnose(job)).attempts.length,1);
  });
 }
 await t.test('cookies, anon and even worker SQL cannot read/write journal or bypass revoked prepare cores',async()=>{
  for(const actor of [f.owner,f.admin,f.agent,f.other]){
   await identity(db,actor,true);await assert.rejects(()=>rpc(db,'worker_ai_attempt_diagnostics',[jobs[0].id]),/permission denied/);
   await assert.rejects(()=>db.exec('select * from private.ai_provider_attempts'),/permission denied/);
  }
  await db.exec('reset role;set role anon');await assert.rejects(()=>rpc(db,'worker_ai_attempt_diagnostics',[jobs[0].id]),/permission denied/);
  await worker();await assert.rejects(()=>db.exec('select * from private.ai_provider_attempts'),/permission denied/);
  await assert.rejects(()=>db.exec('update private.ai_provider_attempts set prepared_at=now()'),/permission denied/);
  await assert.rejects(()=>db.exec('delete from private.ai_provider_attempts'),/permission denied/);
  for(const name of ['prepare_analysis_020_core','prepare_draft_020_core'])await assert.rejects(()=>db.query(`select private.${name}($1,$2,$3)`,[jobs[0].id,jobs[0].lease,req()]),/permission denied/);
 });
 await t.test('renewed leases get new IDs; old tokens remain fenced and uncertain usage is retained',async()=>{
  for(const j of jobs){await db.exec('reset role');await db.query("update public.ai_jobs set lease_until=now()-interval '1 second' where id=$1",[j.id]);await worker();
   const claim=await rpc(db,'worker_claim_'+j.kind,[req()]);assert.equal(claim.attempt,2);assert.equal(claim.id,j.id);
   assert.equal(await rpc(db,'worker_prepare_'+j.kind,[j.id,j.lease,req()]),null);
   const next=await rpc(db,'worker_prepare_'+j.kind,[j.id,claim.lease_token,req()]);assert.notEqual(next.provider_request_id,j.request);
   assert.equal((await rpc(db,'worker_fail_analysis',[j.id,j.lease,'PROVIDER_TIMEOUT',false,null,true,req()])).state,'STALE');
   const terminal=await rpc(db,'worker_fail_analysis',[j.id,claim.lease_token,'PROVIDER_TIMEOUT',false,null,true,req()]);assert.equal(terminal.usage_state,'RECONCILE');
   const d=await diagnose(j.id);assert.equal(d.attempts.length,2);assert.equal(d.uncertain_usage,true);assert.equal(d.provider_usage_verified,false);assert.equal(d.resolution_available,false);
  }
 });
 await t.test('diagnostics reveal only the requested job and cannot mutate usage, queue, audit or receipts',async()=>{
  const state=async()=>{await db.exec('reset role');return(await db.query<any>(`select (select jsonb_agg(to_jsonb(j) order by id) from public.ai_jobs j) jobs,(select jsonb_agg(to_jsonb(a) order by job_id,claim_attempt) from private.ai_provider_attempts a) attempts,(select jsonb_agg(to_jsonb(w)) from private.ai_usage_windows w) usage,(select count(*) from public.activity_events) audit,(select count(*) from private.api_requests) receipts`)).rows[0];};
  const before=await state();const d=await diagnose(jobs[0].id);await diagnose(jobs[0].id);
  for(const forbidden of [f.owner,f.lead.id,f.agency.id,jobs[1].request,'Synthetic','example.test','snapshot','lease_token'])assert.ok(!JSON.stringify(d).includes(forbidden));
  await assert.rejects(()=>rpc(db,'worker_ai_attempt_diagnostics',[req()]),/NOT_FOUND/);assert.deepEqual(await state(),before);
 });
 await t.test('journal failure rolls back dispatch marker and preparation together without spending quota',async()=>{
  for(const kind of ['analysis','draft']){
  await db.exec('reset role;delete from private.request_limits');await identity(db,f.owner);
  const job=kind==='analysis'?(await rpc(db,'submit_analysis',[f.agency.id,f.lead.id,f.lead.version,req(),req()])).job_id
   :(await rpc(db,'submit_draft',[f.agency.id,f.lead.id,f.lead.version,{language:'en',tone:'PROFESSIONAL',instruction:''},req(),req()])).job_id;
  await worker();const claim=await rpc(db,'worker_claim_'+kind,[req()]);
  await db.exec('reset role');const quotaBefore=(await db.query('select * from private.ai_usage_windows order by kind,period_at')).rows;
  await db.exec(`reset role;create function private.fail_attempt_journal() returns trigger language plpgsql as $$ begin raise exception 'JOURNAL_UNAVAILABLE';end $$;create trigger fail_attempt_journal before insert on private.ai_provider_attempts for each row execute function private.fail_attempt_journal();`);
  await worker();await assert.rejects(()=>rpc(db,'worker_prepare_'+kind,[job,claim.lease_token,req()]),/JOURNAL_UNAVAILABLE/);
  await db.exec('reset role');const j=(await db.query<any>('select dispatched_at,usage_state,observed_tokens,lease_token from public.ai_jobs where id=$1',[job])).rows[0];
  assert.equal(j.dispatched_at,null);assert.equal(j.usage_state,'RESERVED');assert.equal(j.observed_tokens,0);assert.equal(j.lease_token,claim.lease_token);
  assert.equal((await db.query('select * from private.ai_provider_attempts where job_id=$1',[job])).rows.length,0);
  assert.deepEqual((await db.query('select * from private.ai_usage_windows order by kind,period_at')).rows,quotaBefore);
  await db.exec('drop trigger fail_attempt_journal on private.ai_provider_attempts;drop function private.fail_attempt_journal()');await worker();assert.ok((await rpc(db,'worker_prepare_'+kind,[job,claim.lease_token,req()])).provider_request_id);
  }
 });
 await t.test('current access revocation blocks preparation and adds no attempt receipt',async()=>{
  await db.exec('reset role');const lead=(await db.query<any>("insert into public.leads(tenant_id,assignee_id,full_name,email,source,created_by) values($1,$2,'Private fixture','private@example.test','MANUAL',$3) returning *",[f.agency.id,f.members[f.agent+f.agency.id],f.owner])).rows[0];
  await identity(db,f.agent);const job=(await rpc(db,'submit_analysis',[f.agency.id,lead.id,lead.version,req(),req()])).job_id;
  await worker();const claim=await rpc(db,'worker_claim_analysis',[req()]);assert.equal(claim.id,job);
  await db.exec('reset role');await db.query('update public.leads set assignee_id=null where id=$1',[lead.id]);await worker();assert.equal(await rpc(db,'worker_prepare_analysis',[job,claim.lease_token,req()]),null);
  const d=await diagnose(job);assert.equal(d.state,'CANCELLED');assert.equal(d.attempts.length,0);assert.equal(d.claims_without_prepare_record,1);
 });
 await t.test('actual dump/load preserves correlation identity, uncertain reservations and private permissions',async()=>{
  const before=await diagnose(jobs[0].id);await db.exec('reset role');const dump=await db.dumpDataDir('none');await db.close();db=new PGlite({loadDataDir:dump});
  assert.deepEqual(await diagnose(jobs[0].id),before);await identity(db,f.owner);await assert.rejects(()=>rpc(db,'worker_ai_attempt_diagnostics',[jobs[0].id]),/permission denied/);
  await worker();await assert.rejects(()=>db.exec('select * from private.ai_provider_attempts'),/permission denied/);
 });
 }finally{await db.close();}
});

test('migration rollback preserves original prepare/grants and existing in-flight legacy claims are not backfilled',async()=>{
 const db=await localDatabase({through:19});try{
  const f=await seedPrivacyFixture(db);await db.exec('reset role');await db.query('update public.agencies set ai_enabled=true,processing_approved=true,ai_daily_limit=100,ai_monthly_limit=100 where id=$1',[f.agency.id]);
  await db.exec('set role service_role');await rpc(db,'worker_set_ai_policy',[true,'fixture-model',['en'],true,req()]);await identity(db,f.owner);const job=(await rpc(db,'submit_analysis',[f.agency.id,f.lead.id,f.lead.version,req(),req()])).job_id;
  await db.exec('reset role;set role service_role');const claim=await rpc(db,'worker_claim_analysis',[req()]);assert.equal((await rpc(db,'worker_prepare_analysis',[job,claim.lease_token,req()])).provider_request_id,undefined);
  await db.exec('reset role');const prior=(await db.query<any>("select pg_get_functiondef('public.worker_prepare_analysis(uuid,uuid,uuid)'::regprocedure) body,proacl::text acl from pg_proc where oid='public.worker_prepare_analysis(uuid,uuid,uuid)'::regprocedure")).rows[0];
  const source=await readFile(new URL('202610080020_ai_attempt_tracking.sql',migrationDir),'utf8');await assert.rejects(()=>db.exec(source.replace('commit;','select 1/0;\ncommit;')),/division by zero/);await db.exec('rollback');
  assert.equal((await db.query<any>("select to_regclass('private.ai_provider_attempts') t")).rows[0].t,null);
  assert.deepEqual((await db.query<any>("select pg_get_functiondef('public.worker_prepare_analysis(uuid,uuid,uuid)'::regprocedure) body,proacl::text acl from pg_proc where oid='public.worker_prepare_analysis(uuid,uuid,uuid)'::regprocedure")).rows[0],prior);
  await db.exec(source);await db.exec('set role service_role');const legacy=aiAttemptDiagnosticsSchema.parse(await rpc(db,'worker_ai_attempt_diagnostics',[job]));assert.equal(legacy.attempts.length,0);assert.equal(legacy.claims_without_prepare_record,1);
  await db.exec('reset role');await db.query("update public.ai_jobs set lease_until=now()-interval '1 second' where id=$1",[job]);await db.exec('set role service_role');const renewed=await rpc(db,'worker_claim_analysis',[req()]);
  const prepared=await rpc(db,'worker_prepare_analysis',[job,renewed.lease_token,req()]);assert.ok(prepared.provider_request_id);const d=aiAttemptDiagnosticsSchema.parse(await rpc(db,'worker_ai_attempt_diagnostics',[job]));assert.equal(d.attempts[0].claim_attempt,2);assert.equal(d.claims_without_prepare_record,1);assert.equal(d.uncertain_usage,true);
 }finally{await db.close();}
});
