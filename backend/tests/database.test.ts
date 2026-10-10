import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const ownerA='00000000-0000-4000-8000-000000000001';
const ownerB='00000000-0000-4000-8000-000000000002';
const agentA='00000000-0000-4000-8000-000000000003';
const agentB='00000000-0000-4000-8000-000000000004';
const unverified='00000000-0000-4000-8000-000000000005';
test('database services enforce tenancy, atomic audit, idempotency and message versions',async t=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated;`);
 for(const id of [ownerA,ownerB,agentA,agentB])await db.query('insert into auth.users values($1,now())',[id]);
 await db.query('insert into auth.users values($1,null)',[unverified]);
 for(const name of ['202610060001_foundation.sql','202610060002_services.sql','202610060003_lead_update.sql','202610060004_workflows.sql','202610060005_lead_controls.sql','202610060006_team.sql','202610060007_notifications.sql','202610060008_capture.sql','202610060009_imports.sql','202610060010_website_intake.sql','202610070011_analysis.sql','202610070012_drafts.sql','202610070013_dashboard.sql','202610070014_hardening.sql','202610070015_intake_key_rotation.sql','202610070016_invitation_key_rotation.sql','202610070017_intake_signing_roots.sql','202610080018_agency_operations.sql','202610080019_platform_health.sql','202610080020_ai_attempt_tracking.sql','202610100021_read_membership.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 async function as(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
 async function rpc(name:string,args:unknown[]){return (await db.query<{result:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;}
 const keyA=crypto.randomUUID();await as(ownerA);const a=await rpc('create_agency',[{name:'Agency A',timezone:'Asia/Dubai',locale:'en'},keyA,crypto.randomUUID()]);
 await as(ownerB);const b=await rpc('create_agency',[{name:'Agency B'},crypto.randomUUID(),crypto.randomUUID()]);
 await db.exec('reset role');
 const ma=(await db.query<{id:string}>("insert into public.memberships(tenant_id,user_id,role) values($1,$2,'AGENT') returning id",[a.agency.id,agentA])).rows[0].id;
 const mb=(await db.query<{id:string}>("insert into public.memberships(tenant_id,user_id,role) values($1,$2,'AGENT') returning id",[b.agency.id,agentB])).rows[0].id;
 await t.test('agency retries preserve exactly one owner and conflict on changed input',async()=>{
  await as(ownerA);const replay=await rpc('create_agency',[{name:'Agency A',timezone:'Asia/Dubai',locale:'en'},keyA,crypto.randomUUID()]);assert.equal(replay.agency.id,a.agency.id);
  await assert.rejects(()=>rpc('create_agency',[{name:'Changed'},keyA,crypto.randomUUID()]),/IDEMPOTENCY_CONFLICT/);
  await db.exec('reset role');const owners=await db.query<{count:number}>("select count(*)::int as count from public.memberships where tenant_id=$1 and role='OWNER'",[a.agency.id]);assert.equal(owners.rows[0].count,1);
 });
 let lead:any;
 const payload={full_name:'Test Buyer',email:'buyer@example.com',initial_message:'Looking for a home',assignee_id:ma};const key=crypto.randomUUID();
 await t.test('lead, initial message and audit commit once',async()=>{
  await as(ownerA);lead=await rpc('create_lead',[a.agency.id,payload,key,crypto.randomUUID()]);
  assert.equal((await rpc('create_lead',[a.agency.id,payload,key,crypto.randomUUID()])).id,lead.id);
  assert.equal((await db.query('select * from public.messages where lead_id=$1',[lead.id])).rows.length,1);
  assert.equal((await db.query('select * from public.activity_events where lead_id=$1',[lead.id])).rows.length,1);
  await assert.rejects(()=>rpc('create_lead',[a.agency.id,{...payload,full_name:'Changed'},key,crypto.randomUUID()]),/IDEMPOTENCY_CONFLICT/);
 });
 await t.test('tenant and assignment checks hold for direct SQL and RPCs',async()=>{
  await as(ownerB);assert.equal((await db.query('select * from public.leads where id=$1',[lead.id])).rows.length,0);assert.equal((await db.query('select * from public.messages where lead_id=$1',[lead.id])).rows.length,0);
  await assert.rejects(()=>rpc('create_lead',[a.agency.id,payload,crypto.randomUUID(),crypto.randomUUID()]),/MEMBERSHIP_REQUIRED/);
  await as(agentA);assert.equal((await db.query('select * from public.leads where id=$1',[lead.id])).rows.length,1);
  const self=await rpc('create_lead',[a.agency.id,{full_name:'Agent Buyer',phone:'+971501234567'},crypto.randomUUID(),crypto.randomUUID()]);assert.equal(self.assignee_id,ma);
  await assert.rejects(()=>rpc('create_lead',[a.agency.id,{...payload,assignee_id:mb},crypto.randomUUID(),crypto.randomUUID()]),/VALIDATION_FAILED/);
  await as(ownerA);const unassigned=await rpc('create_lead',[a.agency.id,{full_name:'Unassigned Buyer',email:'queue@example.com'},crypto.randomUUID(),crypto.randomUUID()]);
  await as(agentA);assert.equal((await db.query('select * from public.leads where id=$1',[unassigned.id])).rows.length,0);
  await assert.rejects(()=>db.query("update public.leads set status='WON' where id=$1",[lead.id]),/permission denied/);
 });
 await t.test('unknown authority and invalid contacts fail without partial writes',async()=>{
  await as(ownerA);
  for(const invalid of [{full_name:'Buyer'},{...payload,tenant_id:b.agency.id},{...payload,budget_min:20,budget_max:10,currency:'AED'}])await assert.rejects(()=>rpc('create_lead',[a.agency.id,invalid,crypto.randomUUID(),crypto.randomUUID()]),/VALIDATION_FAILED/);
  await as(unverified);await assert.rejects(()=>rpc('create_agency',[{name:'Blocked'},crypto.randomUUID(),crypto.randomUUID()]),/AUTH_REQUIRED/);
 });
 await t.test('duplicate warning exposes no matching lead details',async()=>{
  await as(agentA);const duplicate=await rpc('create_lead',[a.agency.id,{full_name:'New Buyer',email:'queue@example.com'},crypto.randomUUID(),crypto.randomUUID()]);assert.equal(duplicate.duplicate_review,true);assert.equal(duplicate.full_name,'New Buyer');
 });
 await t.test('message retries and stale versions preserve current context',async()=>{
  await as(agentA);const body={direction:'INBOUND',body:'New customer requirements',occurred_at:new Date(Date.now()-1000).toISOString(),expected_version:1};const messageKey=crypto.randomUUID();
  const result=await rpc('add_lead_message',[a.agency.id,lead.id,body,messageKey,crypto.randomUUID()]);assert.equal(result.message.author_id,agentA);assert.equal(result.context_version,2);assert.equal(result.lead_version,2);
  assert.equal((await rpc('add_lead_message',[a.agency.id,lead.id,body,messageKey,crypto.randomUUID()])).message.id,result.message.id);
  await assert.rejects(()=>rpc('add_lead_message',[a.agency.id,lead.id,{...body,body:'Stale'},crypto.randomUUID(),crypto.randomUUID()]),/VERSION_CONFLICT/);
  const outbound=await rpc('add_lead_message',[a.agency.id,lead.id,{...body,direction:'OUTBOUND',body:'Actual external reply',expected_version:2},crypto.randomUUID(),crypto.randomUUID()]);assert.equal(outbound.message.delivery_status,'USER_REPORTED');assert.equal(outbound.context_version,2);
  await db.exec('reset role');await db.query('update public.leads set do_not_contact=true where id=$1',[lead.id]);await as(agentA);
  await assert.rejects(()=>rpc('add_lead_message',[a.agency.id,lead.id,{...body,direction:'OUTBOUND',expected_version:3},crypto.randomUUID(),crypto.randomUUID()]),/CONTACT_BLOCKED/);
 });
 await t.test('audit failure rolls back lead, message and retry record',async()=>{
  await db.exec('reset role');await db.exec(`create function public.fail_audit() returns trigger language plpgsql as $$ begin raise exception 'AUDIT_FAIL'; end $$; create trigger fail_audit before insert on public.activity_events for each row execute function public.fail_audit();`);
  const retry=crypto.randomUUID();await as(ownerA);await assert.rejects(()=>rpc('create_lead',[a.agency.id,{full_name:'Rollback Buyer',email:'rollback@example.com',initial_message:'Test'},retry,crypto.randomUUID()]),/AUDIT_FAIL/);
  assert.equal((await db.query("select * from public.leads where email='rollback@example.com'")).rows.length,0);
  await db.exec('reset role');assert.equal((await db.query('select * from private.api_requests where request_key=$1',[retry])).rows.length,0);await db.exec('drop trigger fail_audit on public.activity_events');
 });
 await t.test('lead editing checks versions and tenant authority',async()=>{
  await as(ownerB);await assert.rejects(()=>rpc('update_lead',[b.agency.id,lead.id,{full_name:'Intruder',email:'bad@example.com'},3,crypto.randomUUID()]),/NOT_FOUND/);
  await as(ownerA);const updated=await rpc('update_lead',[a.agency.id,lead.id,{full_name:'Updated Buyer',email:'updated@example.com',budget_min:100,currency:'AED'},3,crypto.randomUUID()]);assert.equal(updated.version,4);assert.equal(updated.context_version,3);
  await assert.rejects(()=>rpc('update_lead',[a.agency.id,lead.id,{full_name:'Stale Update',email:'updated@example.com'},2,crypto.randomUUID()]),/VERSION_CONFLICT/);
 });
 await t.test('revocation takes effect immediately and replay rechecks assignment',async()=>{
  await db.exec('reset role');await db.query('update public.leads set assignee_id=null where id=$1',[lead.id]);await as(agentA);
  await assert.rejects(()=>rpc('add_lead_message',[a.agency.id,lead.id,{direction:'INTERNAL',body:'Note',occurred_at:new Date(Date.now()-1000).toISOString(),expected_version:2},crypto.randomUUID(),crypto.randomUUID()]),/NOT_FOUND/);
  await db.exec('reset role');await db.query('update public.memberships set active=false where id=$1',[ma]);await as(agentA);
  assert.equal((await db.query('select * from public.leads')).rows.length,0);
  await assert.rejects(()=>rpc('create_lead',[a.agency.id,payload,key,crypto.randomUUID()]),/MEMBERSHIP_REQUIRED/);
 });
 }finally{await db.close();}
});
