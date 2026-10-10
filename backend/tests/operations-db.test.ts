import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase,identity,rpc,seedPrivacyFixture,migrationDir} from './helpers/local-db.ts';
import {operationsSnapshotSchema} from '../src/domain/operations.ts';
test('P8 agency operations snapshots preserve current manager scope, queue definitions and read-only recovery evidence',async t=>{
 let db=await localDatabase();try{
 const f=await seedPrivacyFixture(db),ids:string[]=[];
 await db.exec('reset role;delete from private.outbox_events');
 const ownerMember=(await db.query<any>('select id from public.memberships where tenant_id=$1 and user_id=$2',[f.agency.id,f.owner])).rows[0].id;
 const foreignMember=(await db.query<any>('select id from public.memberships where tenant_id=$1 and user_id=$2',[f.foreign.id,f.other])).rows[0].id;
 const task=(await db.query<any>("insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,due_at,created_by) values($1,$2,$3,'INTERNAL','Synthetic reminder',now()-interval '20 minutes',$4) returning id",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner])).rows[0].id;
 const managerTask=(await db.query<any>("insert into public.follow_ups(tenant_id,lead_id,type,title,due_at,created_by) values($1,$2,'INTERNAL','Synthetic manager reminder',now()-interval '30 minutes',$3) returning id",[f.agency.id,f.lead.id,f.owner])).rows[0].id;
 for(const [tenant,actor,lead,member,foreign] of [[f.agency.id,f.owner,f.lead.id,ownerMember,false],[f.foreign.id,f.other,f.foreignLead.id,foreignMember,true]] as const){
  for(const state of ['PENDING','RUNNING','FAILED']){
   const id=crypto.randomUUID();ids.push(id);await db.query(`insert into private.outbox_events(id,tenant_id,event_type,entity_id,dedupe_key,payload,state,created_at,attempts,lease_token,lease_until,completed_at,last_error_code)
   values($1::uuid,$2,'INVITATION_MAIL',$3,($1::uuid)::text,'{"to":"private@example.test","token":"PRIVATE_TOKEN"}',$4,now()-$5::interval,$6,$7,$8,$9,'PRIVATE_ERROR_TEXT')`,[id,tenant,lead,state,foreign?'90 days':state==='PENDING'?'20 minutes':'5 minutes',state==='FAILED'?3:1,state==='RUNNING'?crypto.randomUUID():null,state==='RUNNING'?new Date(Date.now()-5000).toISOString():null,state==='FAILED'?new Date().toISOString():null]);
  }
  for(const state of ['QUEUED','RUNNING','FAILED']){
   const id=crypto.randomUUID();ids.push(id);const inputLead=(await db.query<any>("insert into public.leads(tenant_id,full_name,email,source,created_by) values($1,'Synthetic queued lead','queued-fixture@example.test','MANUAL',$2) returning id",[tenant,actor])).rows[0].id;
   await db.query(`insert into public.ai_jobs(id,tenant_id,lead_id,requester_member_id,created_by,state,input_version,model,prompt_version,schema_version,policy_version,requested_at,month_at,day_at,kind,lease_token,lease_until,completed_at,usage_state,failure_code)
   values($1,$2,$3,$4,$5,$6,1,'synthetic-test-model','fixture','fixture',1,now()-$7::interval,date_trunc('month',now() at time zone 'UTC')::date,(now() at time zone 'UTC')::date,$8,$9,$10,$11,$12,'PRIVATE_PROVIDER_TEXT')`,[id,tenant,inputLead,member,actor,state,foreign?'90 days':state==='QUEUED'?'35 minutes':'5 minutes',state==='RUNNING'?'DRAFT':'ANALYSIS',state==='RUNNING'?crypto.randomUUID():null,state==='RUNNING'?new Date(Date.now()-5000).toISOString():null,state==='FAILED'?new Date().toISOString():null,state==='FAILED'?'RECONCILE':'RESERVED']);
  }
 }
 // Remove fresh lead-trigger jobs so this fixture isolates the explicitly seeded queue ages/states.
 await db.query('delete from private.outbox_events where id<>all($1::uuid[])',[ids]);
 const snapshot=async(tenant=f.agency.id)=>operationsSnapshotSchema.parse(await rpc(db,'agency_operations_snapshot',[tenant]));
 await identity(db,f.owner);
 await t.test('snapshot counts only this agency; all alert categories derive from bounded content-free metadata',async()=>{
  const s=await snapshot();assert.deepEqual(s.reminders.awaiting_creation,3);assert.deepEqual({...s.notifications,oldest_pending_seconds:0},{pending:1,running:1,failed:1,expired_leases:1,oldest_pending_seconds:0});assert.deepEqual({...s.ai,oldest_pending_seconds:0},{queued:1,running:1,failed:1,expired_leases:1,oldest_pending_seconds:0,reconciliation:1});assert.ok(s.notifications.oldest_pending_seconds>=1190&&s.notifications.oldest_pending_seconds<1250);assert.ok(s.ai.oldest_pending_seconds>=2090&&s.ai.oldest_pending_seconds<2150);assert.equal(s.alerts.length,7);
  const output=JSON.stringify(s);for(const text of [...ids,f.lead.id,f.foreignLead.id,f.owner,'private@example.test','PRIVATE_TOKEN','PRIVATE_ERROR_TEXT','PRIVATE_PROVIDER_TEXT','synthetic-test-model'])assert.ok(!output.includes(text));assert.equal(s.cost_amount,null);assert.equal(s.scheduler_verified,false);
 });
 await t.test('admin receives same operational counts but retains owner-only commercial usage permissions',async()=>{
  const owner=await snapshot();await identity(db,f.admin);const admin=await snapshot();assert.deepEqual(admin.notifications,owner.notifications);assert.deepEqual(admin.ai,owner.ai);assert.ok(!('monthly_limit' in admin)&&!('observed_tokens' in admin));await assert.rejects(()=>rpc(db,'analysis_usage',[f.agency.id]),/ROLE_REQUIRED/);
 });
 await t.test('agent/shared-user foreign role, missing membership, anon and service-role cannot use the manager projection',async()=>{
  await identity(db,f.agent);await assert.rejects(()=>snapshot(),/ROLE_REQUIRED/);await identity(db,f.owner);await assert.rejects(()=>snapshot(f.foreign.id),/ROLE_REQUIRED/);await identity(db,f.other);await assert.rejects(()=>snapshot(),/MEMBERSHIP_REQUIRED/);await db.exec('reset role;set role anon');await assert.rejects(()=>snapshot(),/permission denied/);await db.exec('reset role;set role service_role');await assert.rejects(()=>snapshot(),/permission denied/);await identity(db,f.owner);
 });
 await t.test('verification and current membership are rechecked on every read after deactivation',async()=>{
  await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=null where id=$1',[f.owner]);await identity(db,f.owner);await assert.rejects(()=>snapshot(),/AUTH_REQUIRED/);await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=now() where id=$1',[f.owner]);await db.query('update public.memberships set active=false where tenant_id=$1 and user_id=$2',[f.agency.id,f.owner]);await identity(db,f.owner);await assert.rejects(()=>snapshot(),/MEMBERSHIP_REQUIRED/);await db.exec('reset role');await db.query('update public.memberships set active=true where tenant_id=$1 and user_id=$2',[f.agency.id,f.owner]);await identity(db,f.owner);
 });
 await t.test('snapshot reads cannot claim/retry work, alter reservations, add receipts/audits or expose private tables',async()=>{
  await assert.rejects(()=>db.exec('select * from private.outbox_events'),/permission denied/);await db.exec('reset role');const before=(await db.query<any>("select (select jsonb_agg(to_jsonb(o) order by id) from private.outbox_events o) outbox,(select jsonb_agg(to_jsonb(j) order by id) from public.ai_jobs j) ai,(select count(*) from public.activity_events)::int audits,(select count(*) from private.api_requests)::int receipts,(select count(*) from public.notifications)::int notices")).rows[0];await identity(db,f.owner);await snapshot();await snapshot();await db.exec('reset role');const after=(await db.query<any>("select (select jsonb_agg(to_jsonb(o) order by id) from private.outbox_events o) outbox,(select jsonb_agg(to_jsonb(j) order by id) from public.ai_jobs j) ai,(select count(*) from public.activity_events)::int audits,(select count(*) from private.api_requests)::int receipts,(select count(*) from public.notifications)::int notices")).rows[0];assert.deepEqual(after,before);await identity(db,f.owner);
 });
 await t.test('reminder population counts eligible recipient/schedule pairs; recorded, archived and contact-restricted work is excluded',async()=>{
  await db.exec('reset role');await db.query("insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,task_id,schedule_version,dedupe_key) values($1,$2,'FOLLOW_UP_DUE',$3,$4,$3,1,$5)",[f.agency.id,f.members[f.agent+f.agency.id],task,f.lead.id,'due:'+task+':1']);await identity(db,f.owner);assert.equal((await snapshot()).reminders.awaiting_creation,2);await db.exec('reset role');await db.query('update public.leads set archived_at=now() where id=$1',[f.lead.id]);await identity(db,f.owner);assert.equal((await snapshot()).reminders.awaiting_creation,0);await db.exec('reset role');await db.query('update public.leads set archived_at=null,do_not_contact=true where id=$1',[f.lead.id]);await db.query("update public.follow_ups set type='CALL' where id=$1",[managerTask]);await identity(db,f.owner);assert.equal((await snapshot()).reminders.awaiting_creation,0);await db.exec('reset role');await db.query("update public.follow_ups set type='INTERNAL' where id=$1",[managerTask]);await identity(db,f.owner);assert.equal((await snapshot()).reminders.awaiting_creation,2);
 });
 await t.test('empty agency has zero lag/counts; snapshot never claims scheduler verification or delivery success',async()=>{
  await db.exec('reset role');await db.query("update private.outbox_events set state='SUCCEEDED',lease_token=null,lease_until=null where tenant_id=$1",[f.foreign.id]);await db.query("update public.ai_jobs set state='SUCCEEDED',usage_state='CONSUMED',lease_token=null,lease_until=null where tenant_id=$1",[f.foreign.id]);await identity(db,f.other);const s=await snapshot(f.foreign.id);assert.equal(s.notifications.oldest_pending_seconds,0);assert.equal(s.ai.oldest_pending_seconds,0);assert.deepEqual(s.alerts,[]);assert.equal(s.scheduler_verified,false);await identity(db,f.owner);
 });
 await t.test('actual backup/load preserves operational aggregation, current permission scope and private queue boundaries',async()=>{
  const before=await snapshot();await db.exec('reset role');const dump=await db.dumpDataDir('none');await db.close();db=new PGlite({loadDataDir:dump});await identity(db,f.owner);const restored=await snapshot();assert.equal(restored.reminders.awaiting_creation,before.reminders.awaiting_creation);assert.deepEqual(restored.alerts,before.alerts);assert.equal(restored.ai.reconciliation,1);await identity(db,f.agent);await assert.rejects(()=>snapshot(),/ROLE_REQUIRED/);await assert.rejects(()=>db.exec('select * from private.outbox_events'),/permission denied/);
 });
 }finally{await db.close();}
});
test('migration 018 rollback restores previous schema/grants before successful retry',async()=>{
 const db=await localDatabase({through:17});try{const source=await readFile(new URL('202610080018_agency_operations.sql',migrationDir),'utf8');await assert.rejects(()=>db.exec(source.replace('commit;','select 1/0;\ncommit;')),/division by zero/);await db.exec('rollback');assert.equal((await db.query<any>("select to_regprocedure('public.agency_operations_snapshot(uuid)') r")).rows[0].r,null);assert.equal((await db.query<any>("select to_regclass('private.outbox_tenant_operations') r")).rows[0].r,null);await db.exec(source);const f=await seedPrivacyFixture(db);assert.ok(operationsSnapshotSchema.safeParse(await rpc(db,'agency_operations_snapshot',[f.agency.id])).success);await identity(db,f.agent);await assert.rejects(()=>rpc(db,'agency_operations_snapshot',[f.agency.id]),/ROLE_REQUIRED/);}finally{await db.close();}
});
