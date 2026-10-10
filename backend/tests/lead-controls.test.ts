import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { controlSchemas } from '../src/domain/lead-controls.ts';
test('control contracts reject authority, missing confirmation types and undocumented reasons',()=>{
 assert.equal(controlSchemas.assignment.safeParse({expected_version:1,assignee_id:null,reason:'Move workload',tenant_id:crypto.randomUUID()}).success,false);
 assert.equal(controlSchemas.archive.safeParse({expected_version:1,reason:'Archive old lead',cancel_open_tasks:'true'}).success,false);
 assert.equal(controlSchemas['contact-preference'].safeParse({expected_version:1,do_not_contact:false,reason:'x'}).success,false);
});
test('lead controls preserve authorization, queue workload, history, replay and atomic cancellations',async t=>{
 const db=new PGlite(),owner=crypto.randomUUID(),admin=crypto.randomUUID(),agent=crypto.randomUUID(),agent2=crypto.randomUUID(),outside=crypto.randomUUID();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;`);
 for(const id of [owner,admin,agent,agent2,outside])await db.query('insert into auth.users values($1,now())',[id]);
 const migrationDir=new URL('../supabase/migrations/',import.meta.url);for(const file of (await readdir(migrationDir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,migrationDir),'utf8'));
 async function as(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
 async function rpc(name:string,args:unknown[]){return(await db.query<{result:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;}
 await as(owner);const a=(await rpc('create_agency',[{name:'Control Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await as(outside);const b=(await rpc('create_agency',[{name:'Other Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await db.exec('reset role');
 const members:Record<string,string>={};for(const [id,role,label] of [[admin,'ADMIN','Agency Manager'],[agent,'AGENT','Agent One'],[agent2,'AGENT','Agent Two']] as const){members[id]=(await db.query<{id:string}>('insert into public.memberships(tenant_id,user_id,role,display_name) values($1,$2,$3,$4) returning id',[a.id,id,role,label])).rows[0].id;}
 const foreignMember=(await db.query<{id:string}>("insert into public.memberships(tenant_id,user_id,role) values($1,$2,'AGENT') returning id",[b.id,owner])).rows[0].id;
 await as(owner);let lead=await rpc('create_lead',[a.id,{full_name:'Control Buyer',email:'control@example.com',assignee_id:members[agent]},crypto.randomUUID(),crypto.randomUUID()]);
 const future=new Date(Date.now()+86400000).toISOString();let completed:any,open:any,internal:any;
 async function task(type:string,title:string){const result=await rpc('create_follow_up',[a.id,{lead_id:lead.id,type,title,due_at:future,expected_lead_version:lead.version},crypto.randomUUID(),crypto.randomUUID()]);lead.version=result.lead_version;return result.follow_up;}
 async function control(action:string,fields:Record<string,unknown>,key=crypto.randomUUID()){return rpc('mutate_lead_control',[a.id,lead.id,action,{expected_version:lead.version,reason:'Documented workflow change',...fields},key,crypto.randomUUID()]);}
 await t.test('directory reveals active same-tenant choices to managers and only self to agents',async()=>{
  const directory=(await db.query<{id:string;label:string}>('select * from public.list_assignment_members($1)',[a.id])).rows;assert.equal(directory.length,4);assert.ok(directory.some(m=>m.label==='Agent One'));assert.ok(!directory.some(m=>m.id===foreignMember));
  await as(agent);const self=(await db.query<{id:string}>('select * from public.list_assignment_members($1)',[a.id])).rows;assert.equal(self.length,1);assert.equal(self[0].id,members[agent]);
  await assert.rejects(()=>rpc('lead_control_summary',[b.id,lead.id]),/MEMBERSHIP_REQUIRED/);
  await as(owner);assert.equal((await db.query('select * from public.list_assignment_members($1)',[b.id])).rows.length,1);
 });
 await t.test('agent cannot assign/archive/restore/clear contact preference or invoke a foreign lead',async()=>{
  await as(agent);for(const action of ['archive','restore'])await assert.rejects(()=>control(action,{}),/ROLE_REQUIRED/);
  await assert.rejects(()=>control('assignment',{assignee_id:null}),/ROLE_REQUIRED/);
  await assert.rejects(()=>control('contact-preference',{do_not_contact:false}),/ROLE_REQUIRED/);
  await as(outside);await assert.rejects(()=>rpc('mutate_lead_control',[b.id,lead.id,'archive',{expected_version:1,reason:'Outside agency'},crypto.randomUUID(),crypto.randomUUID()]),/NOT_FOUND/);await as(owner);
 });
 await t.test('assignment needs transfer confirmation and moves only open work, retaining completed attribution',async()=>{
  completed=await task('CALL','Completed call');const done=await rpc('change_follow_up',[a.id,completed.id,'complete',{expected_version:1,summary:'Called customer'},crypto.randomUUID(),crypto.randomUUID()]);completed=done.follow_up;lead.version=done.lead_version;
  open=await task('CALL','Open call');internal=await task('INTERNAL','Review file');
  await assert.rejects(()=>control('assignment',{assignee_id:members[agent2]}),/TASK_TRANSFER_CONFIRMATION_REQUIRED/);
  await assert.rejects(()=>control('assignment',{assignee_id:foreignMember,transfer_open_tasks:true}),/VALIDATION_FAILED/);
  const key=crypto.randomUUID(),oldVersion=lead.version;const result=await control('assignment',{assignee_id:members[agent2],transfer_open_tasks:true},key);lead=result.lead;assert.equal(result.affected_open_tasks,2);
  assert.equal((await control('assignment',{expected_version:oldVersion,assignee_id:members[agent2],transfer_open_tasks:true},key)).lead.version,lead.version);
  const rows=(await db.query<{id:string;assignee_id:string;state:string;schedule_version:number}>('select id,assignee_id,state,schedule_version from public.follow_ups where lead_id=$1',[lead.id])).rows;
  assert.equal(rows.find(r=>r.id===completed.id)?.assignee_id,members[agent]);assert.equal(rows.find(r=>r.id===open.id)?.assignee_id,members[agent2]);assert.equal(rows.find(r=>r.id===open.id)?.schedule_version,2);
  await as(agent);assert.equal((await db.query('select * from public.leads where id=$1',[lead.id])).rows.length,0);assert.equal((await db.query('select * from public.follow_ups where lead_id=$1',[lead.id])).rows.length,0);assert.equal((await db.query('select * from public.activity_events where lead_id=$1',[lead.id])).rows.length,0);
  await as(agent2);assert.equal((await db.query('select * from public.follow_ups where lead_id=$1',[lead.id])).rows.length,2);await as(owner);
  await assert.rejects(()=>control('archive',{expected_version:oldVersion,cancel_open_tasks:true}),/VERSION_CONFLICT/);
 });
 await t.test('unassignment moves open tasks to manager queue and manager-created queue tasks stay unassigned',async()=>{
  lead=(await control('assignment',{assignee_id:null,transfer_open_tasks:true})).lead;
  assert.equal((await db.query<{assignee_id:string|null}>('select assignee_id from public.follow_ups where id=$1',[open.id])).rows[0].assignee_id,null);
  const queued=await task('CALL','Manager queue action');assert.equal(queued.assignee_id,null);
  await as(agent2);assert.equal((await db.query('select * from public.follow_ups where lead_id=$1',[lead.id])).rows.length,0);
  await as(admin);assert.equal((await db.query('select * from public.follow_ups where lead_id=$1',[lead.id])).rows.length,4);assert.equal((await rpc('lead_control_summary',[a.id,lead.id])).open_task_count,3);
  const done=await rpc('change_follow_up',[a.id,queued.id,'complete',{expected_version:1,summary:'Manager reviewed queue'},crypto.randomUUID(),crypto.randomUUID()]);lead.version=done.lead_version;await as(owner);
  lead=(await control('assignment',{assignee_id:members[agent2],transfer_open_tasks:true})).lead;
 });
 await t.test('do not contact cancels outreach only, needs manager basis to clear and replay rechecks lead access',async()=>{
  await as(agent2);const key=crypto.randomUUID(),oldVersion=lead.version;const blocked=await control('contact-preference',{do_not_contact:true},key);lead=blocked.lead;assert.equal(blocked.affected_open_tasks,1);assert.equal(lead.do_not_contact,true);
  assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[open.id])).rows[0].state,'CANCELLED');assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[internal.id])).rows[0].state,'OPEN');
  await assert.rejects(()=>control('contact-preference',{do_not_contact:false}),/ROLE_REQUIRED/);
  await as(admin);lead=(await control('contact-preference',{do_not_contact:false,reason:'Customer renewed contact permission'})).lead;assert.equal(lead.do_not_contact,false);
  lead=(await control('assignment',{assignee_id:members[agent],transfer_open_tasks:true})).lead;
  await as(agent2);await assert.rejects(()=>control('contact-preference',{expected_version:oldVersion,do_not_contact:true},key),/NOT_FOUND/);await as(owner);
 });
 await t.test('archive cancellation requires confirmation and forced audit failure rolls back all state',async()=>{
  await assert.rejects(()=>control('archive',{}),/TASK_CONFIRMATION_REQUIRED/);
  await db.exec('reset role');await db.exec(`create function public.fail_control_audit() returns trigger language plpgsql as $$ begin raise exception 'AUDIT_FAIL';end $$;create trigger fail_control_audit before insert on public.activity_events for each row execute function public.fail_control_audit();`);await as(owner);
  await assert.rejects(()=>control('archive',{cancel_open_tasks:true}),/AUDIT_FAIL/);
  assert.equal((await db.query<{archived_at:string|null}>('select archived_at from public.leads where id=$1',[lead.id])).rows[0].archived_at,null);assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[internal.id])).rows[0].state,'OPEN');
  await db.exec('reset role');await db.exec('drop trigger fail_control_audit on public.activity_events');await as(owner);
  const key=crypto.randomUUID(),oldVersion=lead.version;const archived=await control('archive',{cancel_open_tasks:true},key);lead=archived.lead;assert.ok(lead.archived_at);assert.equal(archived.affected_open_tasks,1);
  assert.equal((await control('archive',{expected_version:oldVersion,cancel_open_tasks:true},key)).lead.version,lead.version);
  assert.equal((await db.query('select * from public.list_leads($1)',[a.id])).rows.length,0);
  assert.equal((await db.query('select * from public.list_leads($1,25,$2,null,null,null,true)',[a.id,'Control'])).rows.length,1);
  await assert.rejects(()=>rpc('create_follow_up',[a.id,{lead_id:lead.id,type:'INTERNAL',title:'Archived task',due_at:future,expected_lead_version:lead.version},crypto.randomUUID(),crypto.randomUUID()]),/CONTACT_BLOCKED/);
  const status=lead.status;lead=(await control('restore',{})).lead;assert.equal(lead.archived_at,null);assert.equal(lead.status,status);assert.equal((await db.query("select * from public.follow_ups where lead_id=$1 and state='OPEN'",[lead.id])).rows.length,0);
  assert.equal((await db.query('select * from public.list_leads($1)',[a.id])).rows.length,1);
  await assert.rejects(()=>db.query("update public.activity_events set reason='changed' where lead_id=$1",[lead.id]),/permission denied/);
 });
 await t.test('deactivated target is invalid and mutations reject authority even through direct RPC',async()=>{
  await db.exec('reset role');await db.query('update public.memberships set active=false where id=$1',[members[agent2]]);await as(owner);
  await assert.rejects(()=>control('assignment',{assignee_id:members[agent2],transfer_open_tasks:true}),/VALIDATION_FAILED/);
  await assert.rejects(()=>control('contact-preference',{do_not_contact:true,actor_id:outside}),/VALIDATION_FAILED/);
  await assert.rejects(()=>control('archive',{cancel_open_tasks:'true'}),/VALIDATION_FAILED/);
  await as(agent2);await assert.rejects(()=>rpc('list_assignment_members',[a.id]),/MEMBERSHIP_REQUIRED/);
 });
 }finally{await db.close();}
});
