import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { zonedInputToIso,createFollowUpSchema,statusChangeSchema } from '../src/domain/workflows.ts';
test('agency local time converts independently of browser timezone and rejects DST ambiguity',()=>{
 assert.equal(zonedInputToIso('2026-10-07T10:30','Asia/Dubai'),'2026-10-07T06:30:00.000Z');
 assert.equal(zonedInputToIso('2026-10-07T10:30','Asia/Karachi'),'2026-10-07T05:30:00.000Z');
 assert.equal(zonedInputToIso('2026-07-07T10:30','America/New_York'),'2026-07-07T14:30:00.000Z');
 assert.throws(()=>zonedInputToIso('2026-03-08T02:30','America/New_York'),/does not exist/);
 assert.throws(()=>zonedInputToIso('2026-11-01T01:30','America/New_York'),/occurs twice/);
 assert.throws(()=>zonedInputToIso('2026-02-30T10:30','Asia/Dubai'),/valid date/);
});
test('workflow inputs reject future outcomes, past tasks and missing qualification facts',()=>{
 assert.equal(statusChangeSchema.safeParse({status:'QUALIFIED',expected_version:1}).success,false);
 assert.equal(statusChangeSchema.safeParse({status:'WON',expected_version:1,outcome_summary:'Confirmed sale',won_at:new Date(Date.now()+86400000).toISOString()}).success,false);
 assert.equal(createFollowUpSchema.safeParse({lead_id:crypto.randomUUID(),type:'CALL',title:'Call',due_at:'2020-01-01T00:00:00Z',expected_lead_version:1}).success,false);
});
test('task and lifecycle transactions enforce evidence, tenancy, versions and atomic closure',async t=>{
 const db=new PGlite();const owner=crypto.randomUUID(),agent=crypto.randomUUID(),other=crypto.randomUUID();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;`);
 for(const id of [owner,agent,other])await db.query('insert into auth.users values($1,now())',[id]);
 for(const name of ['202610060001_foundation.sql','202610060002_services.sql','202610060003_lead_update.sql','202610060004_workflows.sql','202610060005_lead_controls.sql','202610060006_team.sql','202610060007_notifications.sql','202610060008_capture.sql','202610060009_imports.sql','202610060010_website_intake.sql','202610070011_analysis.sql','202610070012_drafts.sql','202610070013_dashboard.sql','202610070014_hardening.sql','202610070015_intake_key_rotation.sql','202610070016_invitation_key_rotation.sql','202610070017_intake_signing_roots.sql','202610080018_agency_operations.sql','202610080019_platform_health.sql','202610080020_ai_attempt_tracking.sql','202610100021_read_membership.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'));
 async function as(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
 async function rpc(name:string,args:unknown[]){return(await db.query<{result:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;}
 await as(owner);const a=(await rpc('create_agency',[{name:'Workflow Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await db.exec('reset role');const membership=(await db.query<{id:string}>("insert into public.memberships(tenant_id,user_id,role) values($1,$2,'AGENT') returning id",[a.id,agent])).rows[0].id;
 await as(agent);let lead=await rpc('create_lead',[a.id,{full_name:'Workflow Buyer',email:'workflow@example.com'},crypto.randomUUID(),crypto.randomUUID()]);
 async function status(payload:Record<string,unknown>,key=crypto.randomUUID()){return rpc('change_lead_status',[a.id,lead.id,{expected_version:lead.version,...payload},key,crypto.randomUUID()]);}
 const future=new Date(Date.now()+86400000).toISOString();let task:any;
 await t.test('contacted needs an actual logged outbound attempt and qualified needs explicit unknown acknowledgement',async()=>{
  await assert.rejects(()=>status({status:'CONTACTED'}),/STATUS_REQUIREMENT/);
  await assert.rejects(()=>status({status:'FOLLOW_UP'}),/STATUS_REQUIREMENT/);
  await assert.rejects(()=>status({status:'QUALIFIED',confirmed_intent:'BUY',qualification_summary:'Confirmed buyer'}),/STATUS_REQUIREMENT/);
  const message=await rpc('add_lead_message',[a.id,lead.id,{direction:'OUTBOUND',body:'Logged external call',occurred_at:new Date(Date.now()-1000).toISOString(),expected_version:lead.version},crypto.randomUUID(),crypto.randomUUID()]);lead.version=message.lead_version;
  lead=(await status({status:'CONTACTED'})).lead;
  lead=(await status({status:'QUALIFIED',confirmed_intent:'BUY',qualification_summary:'Needs a two bedroom home',locations:['Marina'],acknowledge_unknowns:true})).lead;assert.equal(lead.confirmed_intent,'BUY');assert.equal(lead.context_version,2);
 });
 await t.test('create, retry and assignment policy enforce scope without duplicate tasks',async()=>{
  const payload={lead_id:lead.id,type:'CALL',title:'Discuss viewing',due_at:future,expected_lead_version:lead.version};const key=crypto.randomUUID();
  const result=await rpc('create_follow_up',[a.id,payload,key,crypto.randomUUID()]);task=result.follow_up;lead.version=result.lead_version;assert.equal(task.assignee_id,membership);
  assert.equal((await rpc('create_follow_up',[a.id,payload,key,crypto.randomUUID()])).follow_up.id,task.id);
  await assert.rejects(()=>rpc('create_follow_up',[a.id,{...payload,title:'Changed'},key,crypto.randomUUID()]),/IDEMPOTENCY_CONFLICT/);
  await assert.rejects(()=>rpc('create_follow_up',[a.id,payload,crypto.randomUUID(),crypto.randomUUID()]),/VERSION_CONFLICT/);
  await assert.rejects(()=>db.query("update public.follow_ups set state='COMPLETED' where id=$1",[task.id]),/permission denied/);
  await as(other);const b=(await rpc('create_agency',[{name:'Other Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
  assert.equal((await db.query('select * from public.follow_ups where id=$1',[task.id])).rows.length,0);
  await assert.rejects(()=>rpc('change_follow_up',[b.id,task.id,'complete',{expected_version:1,summary:'Completed'},crypto.randomUUID(),crypto.randomUUID()]),/NOT_FOUND/);
  await as(agent);lead=(await status({status:'FOLLOW_UP'})).lead;
 });
 await t.test('reschedule advances schedule version; completion preserves lead lifecycle',async()=>{
  const result=await rpc('change_follow_up',[a.id,task.id,'reschedule',{expected_version:task.version,due_at:new Date(Date.now()+172800000).toISOString(),reason:'Customer requested tomorrow'},crypto.randomUUID(),crypto.randomUUID()]);task=result.follow_up;lead.version=result.lead_version;assert.equal(task.schedule_version,2);
  await assert.rejects(()=>rpc('change_follow_up',[a.id,task.id,'complete',{expected_version:1,summary:'Called buyer'},crypto.randomUUID(),crypto.randomUUID()]),/VERSION_CONFLICT/);
  const key=crypto.randomUUID();const payload={expected_version:task.version,summary:'Confirmed viewing appointment'};
  const done=await rpc('change_follow_up',[a.id,task.id,'complete',payload,key,crypto.randomUUID()]);task=done.follow_up;lead.version=done.lead_version;assert.equal(task.state,'COMPLETED');
  assert.equal((await rpc('change_follow_up',[a.id,task.id,'complete',payload,key,crypto.randomUUID()])).follow_up.version,task.version);
  assert.equal((await db.query<{status:string}>('select status from public.leads where id=$1',[lead.id])).rows[0].status,'FOLLOW_UP');
  await assert.rejects(()=>rpc('change_follow_up',[a.id,task.id,'cancel',{expected_version:task.version,reason:'Cancel later'},crypto.randomUUID(),crypto.randomUUID()]),/TASK_NOT_OPEN/);
 });
 await t.test('closing requires explicit cancellation and the audit is transactional',async()=>{
  const result=await rpc('create_follow_up',[a.id,{lead_id:lead.id,type:'VIEWING',title:'Second viewing',due_at:future,expected_lead_version:lead.version},crypto.randomUUID(),crypto.randomUUID()]);task=result.follow_up;lead.version=result.lead_version;
  const payload={status:'WON',won_at:new Date(Date.now()-1000).toISOString(),outcome_summary:'Signed sale agreement',deal_value:1000000,deal_currency:'AED'};
  await assert.rejects(()=>status(payload),/TASK_CONFIRMATION_REQUIRED/);
  assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[task.id])).rows[0].state,'OPEN');
  await db.exec('reset role');await db.exec(`create function public.fail_workflow_audit() returns trigger language plpgsql as $$ begin raise exception 'AUDIT_FAIL'; end $$;create trigger fail_workflow_audit before insert on public.activity_events for each row execute function public.fail_workflow_audit();`);await as(agent);
  await assert.rejects(()=>status({...payload,cancel_open_tasks:true}),/AUDIT_FAIL/);
  assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[task.id])).rows[0].state,'OPEN');
  await db.exec('reset role');await db.exec('drop trigger fail_workflow_audit on public.activity_events');await as(agent);
  const key=crypto.randomUUID(),version=lead.version;const won=await status({...payload,cancel_open_tasks:true},key);lead=won.lead;assert.equal(won.cancelled_tasks,1);assert.equal(lead.status,'WON');assert.equal(Number(lead.deal_value),1000000);
  assert.equal((await status({...payload,expected_version:version,cancel_open_tasks:true},key)).lead.version,lead.version);
  assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[task.id])).rows[0].state,'CANCELLED');
  await assert.rejects(()=>status({status:'CONTACTED'}),/STATUS_REQUIREMENT/);
  lead=(await status({status:'CONTACTED',reason:'Buyer resumed their search'})).lead;assert.equal(lead.won_at,null);
  const history=(await db.query<{details:any}>("select details from public.activity_events where lead_id=$1 and event_type='STATUS_CONTACTED' order by created_at desc limit 1",[lead.id])).rows[0].details;
  assert.equal(history.previous_status,'WON');assert.equal(history.previous_outcome.outcome_summary,'Signed sale agreement');
  assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[task.id])).rows[0].state,'CANCELLED');
 });
 await t.test('SQL rejects past due times and qualification works with known budget without acknowledgement',async()=>{
  const payload={lead_id:lead.id,type:'CALL',title:'Past task',due_at:'2020-01-01T00:00:00Z',expected_lead_version:lead.version};
  await assert.rejects(()=>rpc('create_follow_up',[a.id,payload,crypto.randomUUID(),crypto.randomUUID()]),/VALIDATION_FAILED/);
  const known=await rpc('create_lead',[a.id,{full_name:'Known Buyer',email:'known@example.com',budget_min:1000000,currency:'AED'},crypto.randomUUID(),crypto.randomUUID()]);
  const qualified=await rpc('change_lead_status',[a.id,known.id,{status:'QUALIFIED',expected_version:1,confirmed_intent:'BUY',qualification_summary:'Confirmed known needs',locations:['Marina']},crypto.randomUUID(),crypto.randomUUID()]);assert.equal(qualified.lead.qualification_unknowns_ack,false);
 });
 await t.test('do not contact permits internal tasks and revocation removes task access',async()=>{
  await db.exec('reset role');await db.query('update public.leads set do_not_contact=true where id=$1',[lead.id]);await as(agent);
  const payload={lead_id:lead.id,title:'Review file',due_at:future,expected_lead_version:lead.version};
  await assert.rejects(()=>rpc('create_follow_up',[a.id,{...payload,type:'CALL'},crypto.randomUUID(),crypto.randomUUID()]),/CONTACT_BLOCKED/);
  const result=await rpc('create_follow_up',[a.id,{...payload,type:'INTERNAL'},crypto.randomUUID(),crypto.randomUUID()]);task=result.follow_up;
  await db.exec('reset role');await db.query('update public.leads set assignee_id=null where id=$1',[lead.id]);await as(agent);
  assert.equal((await db.query('select * from public.follow_ups where id=$1',[task.id])).rows.length,0);
  await assert.rejects(()=>rpc('change_follow_up',[a.id,task.id,'complete',{expected_version:1,summary:'Reviewed'},crypto.randomUUID(),crypto.randomUUID()]),/NOT_FOUND/);
  await db.exec('reset role');await db.query('update public.leads set assignee_id=$1 where id=$2',[membership,lead.id]);
  await db.query('update public.memberships set active=false where id=$1',[membership]);await as(agent);
  assert.equal((await db.query('select * from public.follow_ups where id=$1',[task.id])).rows.length,0);
  await assert.rejects(()=>rpc('change_follow_up',[a.id,task.id,'complete',{expected_version:1,summary:'Reviewed'},crypto.randomUUID(),crypto.randomUUID()]),/MEMBERSHIP_REQUIRED/);
 });
 }finally{await db.close();}
});
