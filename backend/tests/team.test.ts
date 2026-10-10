import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
test('team services enforce invitations, seats, role hierarchy, offboarding and fresh MFA ownership',async t=>{
 const db=new PGlite();const owner=crypto.randomUUID(),admin=crypto.randomUUID(),agent=crypto.randomUUID(),replacement=crypto.randomUUID(),invitee=crypto.randomUUID(),wrong=crypto.randomUUID(),outside=crypto.randomUUID(),unverified=crypto.randomUUID();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,email text);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;grant usage on schema auth to authenticated;`);
 for(const [id,email] of [[owner,'owner@example.com'],[admin,'admin@example.com'],[agent,'agent@example.com'],[replacement,'replacement@example.com'],[invitee,'new@example.com'],[wrong,'wrong@example.com'],[outside,'outside@example.com'],[unverified,'unverified@example.com']])await db.query('insert into auth.users values($1,$2,$3)',[id,id===unverified?null:new Date().toISOString(),email]);
 const dir=new URL('../supabase/migrations/',import.meta.url);for(const name of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,dir),'utf8'));
 async function as(id:string,fresh=false,age=0){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({aal:fresh?'aal2':'aal1',amr:fresh?[{method:'totp',timestamp:Math.floor(Date.now()/1000)-age}]:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})]);await db.exec('set role authenticated');}
 async function rpc(name:string,args:unknown[]){return(await db.query<{result:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;}
 await as(owner);const a=(await rpc('create_agency',[{name:'Team Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await as(outside);const b=(await rpc('create_agency',[{name:'Other Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await db.exec('reset role');const members:Record<string,string>={};for(const [id,role] of [[admin,'ADMIN'],[agent,'AGENT'],[replacement,'AGENT']])members[id]=(await db.query<{id:string}>('insert into public.memberships(tenant_id,user_id,role) values($1,$2,$3) returning id',[a.id,id,role])).rows[0].id;
 await as(owner);let snapshot=await rpc('team_snapshot',[a.id]);const ownerMember=snapshot.membership.id;let agencyVersion=snapshot.agency.version;
 async function settings(extra:Record<string,unknown>={},key=crypto.randomUUID()){const result=await rpc('update_agency_settings',[a.id,{expected_version:agencyVersion,name:'Team Agency',timezone:'Asia/Dubai',locale:'en',processing_approved:false,processing_reference:'',ai_enabled:false,...extra},key,crypto.randomUUID()]);agencyVersion=result.version;return result;}
 const token='a'.repeat(64);let invite:any;
 await t.test('profile edits are self-only, versioned and directories respect current tenant/role',async()=>{
  const key=crypto.randomUUID();await as(agent);const payload={display_name:'Agent A',expected_version:1};const profile=await rpc('update_my_profile',[a.id,payload,key,crypto.randomUUID()]);assert.equal(profile.version,2);
  assert.equal((await rpc('update_my_profile',[a.id,payload,key,crypto.randomUUID()])).version,2);
  await assert.rejects(()=>rpc('update_my_profile',[a.id,{...payload,display_name:'Changed'},crypto.randomUUID(),crypto.randomUUID()]),/VERSION_CONFLICT/);
  const list=(await db.query<{id:string}>('select * from public.list_team_members($1)',[a.id])).rows;assert.equal(list.length,1);assert.equal(list[0].id,members[agent]);
  assert.equal((await rpc('team_snapshot',[a.id])).pilot,null);await assert.rejects(()=>rpc('team_snapshot',[b.id]),/MEMBERSHIP_REQUIRED/);await as(owner);
 });
 await t.test('owner configures seats; admin cannot change commercial limits and processing gates protect AI',async()=>{
  await assert.rejects(()=>rpc('create_team_invitation',[a.id,{email:'new@example.com',role:'AGENT'},digest(token),crypto.randomUUID(),crypto.randomUUID()]),/SEAT_LIMIT_REQUIRED/);
  await settings({seat_limit:5,ai_monthly_limit:10});await assert.rejects(()=>settings({seat_limit:3}),/SEAT_LIMIT_REACHED/);
  await as(admin);await assert.rejects(()=>settings({seat_limit:10}),/ROLE_REQUIRED/);await as(owner);
  await assert.rejects(()=>settings({ai_enabled:true}),/PROCESSING_REQUIRED/);
 });
 await t.test('pending invite reserves a seat; retry is unique and private token hash is not disclosed',async()=>{
  const key=crypto.randomUUID(),payload={email:'new@example.com',role:'AGENT'};invite=await rpc('create_team_invitation',[a.id,payload,digest(token),key,crypto.randomUUID()]);assert.equal(invite.token_hash,undefined);
  assert.equal((await rpc('create_team_invitation',[a.id,payload,digest(token),key,crypto.randomUUID()])).id,invite.id);
  await assert.rejects(()=>rpc('create_team_invitation',[a.id,{email:'second@example.com',role:'AGENT'},digest('b'.repeat(64)),crypto.randomUUID(),crypto.randomUUID()]),/SEAT_LIMIT_REACHED/);
  await assert.rejects(()=>db.query('select token_hash from public.invitations'),/permission denied/);
  await db.exec('reset role');const retry=(await db.query<{response:any}>('select response from private.api_requests where request_key=$1',[key])).rows[0].response;assert.equal(JSON.stringify(retry).includes(token),false);assert.equal(retry.token_hash,undefined);await as(owner);
 });
 await t.test('acceptance checks verified matching email and single-use token; consumes reservation atomically',async()=>{
  await as(wrong);await assert.rejects(()=>rpc('accept_team_invitation',[digest(token),'Wrong User',crypto.randomUUID(),crypto.randomUUID()]),/INVITATION_UNAVAILABLE/);
  await as(unverified);await assert.rejects(()=>rpc('accept_team_invitation',[digest(token),'Unverified User',crypto.randomUUID(),crypto.randomUUID()]),/AUTH_REQUIRED/);
  await as(invitee);const key=crypto.randomUUID();const result=await rpc('accept_team_invitation',[digest(token),'New Agent',key,crypto.randomUUID()]);assert.equal(result.tenant_id,a.id);assert.equal(result.membership.role,'AGENT');
  assert.equal((await rpc('accept_team_invitation',[digest(token),'New Agent',key,crypto.randomUUID()])).membership.id,result.membership.id);
  await assert.rejects(()=>rpc('accept_team_invitation',[digest(token),'New Agent',crypto.randomUUID(),crypto.randomUUID()]),/INVITATION_UNAVAILABLE/);
  await as(owner);const seats=(await rpc('team_snapshot',[a.id])).pilot;assert.equal(seats.active_seats,5);assert.equal(seats.pending_seats,0);
 });
 await t.test('resend invalidates previous token; expiry/revoke release seats without a cleanup job',async()=>{
  await settings({seat_limit:6});const old='c'.repeat(64),fresh='d'.repeat(64);let row=await rpc('create_team_invitation',[a.id,{email:'wrong@example.com',role:'AGENT'},digest(old),crypto.randomUUID(),crypto.randomUUID()]);
  row=await rpc('change_team_invitation',[a.id,row.id,'resend',{expected_version:row.version},digest(fresh),crypto.randomUUID(),crypto.randomUUID()]);
  await as(wrong);await assert.rejects(()=>rpc('accept_team_invitation',[digest(old),'Wrong Agent',crypto.randomUUID(),crypto.randomUUID()]),/INVITATION_UNAVAILABLE/);await as(owner);
  await db.exec('reset role');await db.query("update public.invitations set expires_at=now()-interval '1 hour' where id=$1",[row.id]);await as(owner);
  assert.equal((await rpc('team_snapshot',[a.id])).pilot.pending_seats,0);await as(wrong);await assert.rejects(()=>rpc('accept_team_invitation',[digest(fresh),'Wrong Agent',crypto.randomUUID(),crypto.randomUUID()]),/INVITATION_UNAVAILABLE/);await as(owner);
  const revoked=await rpc('change_team_invitation',[a.id,row.id,'revoke',{expected_version:row.version},null,crypto.randomUUID(),crypto.randomUUID()]);assert.equal(revoked.state,'REVOKED');
 });
 await t.test('admin cannot promote self/manage owner or admin; elevations require recent aal2',async()=>{
  const payload={expected_version:1,role:'ADMIN',reason:'Staff role update'};await as(admin);
  await assert.rejects(()=>rpc('change_team_member',[a.id,members[admin],payload,crypto.randomUUID(),crypto.randomUUID()]),/ROLE_REQUIRED/);
  await assert.rejects(()=>rpc('change_team_member',[a.id,ownerMember,{...payload,active:false},crypto.randomUUID(),crypto.randomUUID()]),/ROLE_REQUIRED/);
  await assert.rejects(()=>rpc('create_team_invitation',[a.id,{email:'manager@example.com',role:'ADMIN'},digest('e'.repeat(64)),crypto.randomUUID(),crypto.randomUUID()]),/ROLE_REQUIRED/);
  await as(owner);await assert.rejects(()=>rpc('change_team_member',[a.id,members[replacement],payload,crypto.randomUUID(),crypto.randomUUID()]),/RECENT_MFA_REQUIRED/);
  await as(owner,true,600);await assert.rejects(()=>rpc('change_team_member',[a.id,members[replacement],payload,crypto.randomUUID(),crypto.randomUUID()]),/RECENT_MFA_REQUIRED/);await as(owner);
 });
 await t.test('offboarding requires workload confirmation, transfers all open work and revokes next request',async()=>{
  await as(agent);const lead=await rpc('create_lead',[a.id,{full_name:'Assigned Buyer',email:'buyer@example.com'},crypto.randomUUID(),crypto.randomUUID()]);let created=await rpc('create_follow_up',[a.id,{lead_id:lead.id,type:'CALL',title:'Callback',due_at:new Date(Date.now()+86400000).toISOString(),expected_lead_version:1},crypto.randomUUID(),crypto.randomUUID()]);
  const done=await rpc('change_follow_up',[a.id,created.follow_up.id,'complete',{expected_version:1,summary:'Completed earlier call'},crypto.randomUUID(),crypto.randomUUID()]);const open=await rpc('create_follow_up',[a.id,{lead_id:lead.id,type:'CALL',title:'Next callback',due_at:new Date(Date.now()+86400000).toISOString(),expected_lead_version:done.lead_version},crypto.randomUUID(),crypto.randomUUID()]);
  await as(admin);const fields={expected_version:2,active:false,reason:'Staff offboarding',replacement_id:members[replacement]};
  await assert.rejects(()=>rpc('change_team_member',[a.id,members[agent],fields,crypto.randomUUID(),crypto.randomUUID()]),/WORKLOAD_CONFIRMATION_REQUIRED/);
  const key=crypto.randomUUID();const result=await rpc('change_team_member',[a.id,members[agent],{...fields,transfer_workload:true},key,crypto.randomUUID()]);assert.equal(result.active,false);assert.equal(result.affected_leads,1);
  assert.equal((await rpc('change_team_member',[a.id,members[agent],{...fields,transfer_workload:true},key,crypto.randomUUID()])).version,result.version);
  assert.equal((await db.query<{assignee_id:string}>('select assignee_id from public.leads where id=$1',[lead.id])).rows[0].assignee_id,members[replacement]);
  const tasks=(await db.query<{id:string;assignee_id:string}>('select id,assignee_id from public.follow_ups where lead_id=$1',[lead.id])).rows;assert.equal(tasks.find(task=>task.id===created.follow_up.id)?.assignee_id,members[agent]);assert.equal(tasks.find(task=>task.id===open.follow_up.id)?.assignee_id,members[replacement]);
  await as(agent);await assert.rejects(()=>rpc('team_snapshot',[a.id]),/MEMBERSHIP_REQUIRED/);assert.equal((await db.query('select * from public.leads where id=$1',[lead.id])).rows.length,0);await as(owner);
 });
 await t.test('audit failure rolls back deactivation and owner transfer atomically',async()=>{
  await db.exec('reset role');await db.exec(`create function public.fail_team_audit() returns trigger language plpgsql as $$ begin raise exception 'AUDIT_FAIL';end $$;create trigger fail_team_audit before insert on public.activity_events for each row execute function public.fail_team_audit();`);await as(owner,true);
  await assert.rejects(()=>rpc('change_team_member',[a.id,members[replacement],{expected_version:1,active:false,replacement_id:null,transfer_workload:true,reason:'Move to manager queue'},crypto.randomUUID(),crypto.randomUUID()]),/AUDIT_FAIL/);
  await assert.rejects(()=>rpc('transfer_agency_owner',[a.id,{expected_version:1,target_member_id:members[admin],target_expected_version:1,confirmed:true,reason:'Transfer agency ownership'},crypto.randomUUID(),crypto.randomUUID()]),/AUDIT_FAIL/);
  await db.exec('reset role');assert.equal((await db.query<{role:string}>('select role from public.memberships where id=$1',[ownerMember])).rows[0].role,'OWNER');assert.equal((await db.query<{active:boolean}>('select active from public.memberships where id=$1',[members[replacement]])).rows[0].active,true);
  await db.exec('reset role');await db.exec('drop trigger fail_team_audit on public.activity_events');await as(owner);
 });
 await t.test('direct reads and RPCs preserve commercial privacy, manager scope and strict payloads',async()=>{
  await as(replacement);
  await assert.rejects(()=>db.query('select seat_limit,processing_reference from public.agencies where id=$1',[a.id]),/permission denied/);
  await assert.rejects(()=>db.query('select * from public.list_team_invitations($1)',[a.id]),/ROLE_REQUIRED/);
  await assert.rejects(()=>rpc('update_my_profile',[a.id,{display_name:'Injected',expected_version:1,role:'OWNER'},crypto.randomUUID(),crypto.randomUUID()]),/VALIDATION_FAILED/);
  await as(outside);await assert.rejects(()=>db.query('select * from public.list_team_members($1)',[a.id]),/MEMBERSHIP_REQUIRED/);
  await as(owner);await assert.rejects(()=>rpc('change_team_member',[a.id,members[replacement],{expected_version:1,role:'ADMIN',active:false,reason:'Invalid caller authority',user_id:outside},crypto.randomUUID(),crypto.randomUUID()]),/VALIDATION_FAILED/);
 });
 await t.test('admin invitation creation and acceptance both require recent MFA; outbox is private and deduplicated',async()=>{
  const adminToken='f'.repeat(64),fields={email:'wrong@example.com',role:'ADMIN'};
  await as(owner);await assert.rejects(()=>rpc('create_team_invitation',[a.id,fields,digest(adminToken),crypto.randomUUID(),crypto.randomUUID()]),/RECENT_MFA_REQUIRED/);
  await as(owner,true);const row=await rpc('create_team_invitation',[a.id,fields,digest(adminToken),crypto.randomUUID(),crypto.randomUUID()]);
  await as(admin);assert.equal((await db.query<{id:string}>('select * from public.list_team_invitations($1)',[a.id])).rows.some(i=>i.id===row.id),false);
  await as(wrong);await assert.rejects(()=>rpc('accept_team_invitation',[digest(adminToken),'New Manager',crypto.randomUUID(),crypto.randomUUID()]),/RECENT_MFA_REQUIRED/);
  await as(wrong,true);const key=crypto.randomUUID();const accepted=await rpc('accept_team_invitation',[digest(adminToken),'New Manager',key,crypto.randomUUID()]);assert.equal(accepted.membership.role,'ADMIN');await rpc('accept_team_invitation',[digest(adminToken),'New Manager',key,crypto.randomUUID()]);
  await assert.rejects(()=>db.query('select * from private.outbox_events'),/permission denied/);
  await db.exec('reset role');assert.equal((await db.query<{count:number}>("select count(*)::int as count from private.outbox_events where entity_id=$1 and event_type='INVITE_ACCEPTED'",[row.id])).rows[0].count,1);await as(owner);
 });
 await t.test('owner transfer rejects stale authentication/targets and keeps exactly one owner on retry',async()=>{
  const fields={expected_version:1,target_member_id:members[admin],target_expected_version:1,confirmed:true,reason:'Transfer agency ownership'};
  await assert.rejects(()=>rpc('transfer_agency_owner',[a.id,fields,crypto.randomUUID(),crypto.randomUUID()]),/RECENT_MFA_REQUIRED/);
  await as(owner,true);const key=crypto.randomUUID();const result=await rpc('transfer_agency_owner',[a.id,fields,key,crypto.randomUUID()]);assert.equal(result.owner_member_id,members[admin]);
  assert.equal((await rpc('transfer_agency_owner',[a.id,fields,key,crypto.randomUUID()])).owner_member_id,members[admin]);
  await db.exec('reset role');assert.equal((await db.query("select * from public.memberships where tenant_id=$1 and role='OWNER' and active",[a.id])).rows.length,1);await as(owner,true);
  await assert.rejects(()=>rpc('transfer_agency_owner',[a.id,{...fields,target_member_id:members[replacement]},crypto.randomUUID(),crypto.randomUUID()]),/ROLE_REQUIRED/);
 });
 }finally{await db.close();}
});
