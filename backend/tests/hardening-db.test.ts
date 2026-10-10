import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localDatabase,identity,rpc,seedPrivacyFixture} from './helpers/local-db.ts';

test('P8 privacy intake, current authority, holds, atomic audit and content-free health',async t=>{
 const db=await localDatabase();try{
 const f=await seedPrivacyFixture(db),request=()=>crypto.randomUUID();let c:any;
 const payload={kind:'LEAD_ERASURE',lead_id:f.lead.id,expected_version:f.lead.version,reason:'Synthetic customer erasure request'},key=request();
 const create=(body:unknown=payload,k=request(),tenant=f.agency.id)=>rpc(db,'request_privacy_case',[tenant,body,k,request()]);
 const act=(action:string,version=c.version,extra:Record<string,unknown>={},k=request(),id=c.id)=>rpc(db,'triage_privacy_case',[f.agency.id,id,{action,expected_version:version,reason:'Synthetic review reason',...extra},k,request()]);
 async function clearLimit(){await db.exec('reset role;delete from private.request_limits');await identity(db,f.owner,true);}
 await t.test('request requires owner, verified identity and fresh TOTP even on retries',async()=>{
  await identity(db,f.admin,true);await assert.rejects(()=>create(),/ROLE_REQUIRED/);await identity(db,f.agent,true);await assert.rejects(()=>create(),/ROLE_REQUIRED/);await identity(db,f.owner);await assert.rejects(()=>create(),/RECENT_MFA_REQUIRED/);await identity(db,f.owner,true,301);await assert.rejects(()=>create(),/RECENT_MFA_REQUIRED/);await identity(db,f.owner,true);c=await create(payload,key);assert.equal(c.state,'REQUESTED');assert.equal(c.version,1);
  await identity(db,f.owner);await assert.rejects(()=>create(payload,key),/RECENT_MFA_REQUIRED/);await identity(db,f.owner,true);
 });
 await t.test('tenant/parent, stale versions, duplicate scope and strict direct SQL inputs are enforced',async()=>{
  await assert.rejects(()=>create({...payload,lead_id:f.foreignLead.id}),/NOT_FOUND/);await assert.rejects(()=>create(payload,request(),f.foreign.id),/ROLE_REQUIRED/);await assert.rejects(()=>create({...payload,expected_version:2}),/VERSION_CONFLICT/);await assert.rejects(()=>create(),/PRIVACY_CASE_EXISTS/);
  for(const expected_version of [0,-1,1.5,2147483648,'1',null])await assert.rejects(()=>create({...payload,expected_version}),/VALIDATION_FAILED/);
  for(const extra of [{approved:true},{actor_id:f.owner},{tenant_id:f.agency.id},{lead_id:null},{kind:'PURGE'}])await assert.rejects(()=>create({...payload,...extra}),/VALIDATION_FAILED/);
 });
 await t.test('manager review requires verification reference; agent cannot list or triage',async()=>{
  await identity(db,f.agent,true);await assert.rejects(()=>rpc(db,'list_privacy_cases',[f.agency.id]),/ROLE_REQUIRED/);assert.equal((await db.query('select * from public.privacy_cases')).rows.length,0);await assert.rejects(()=>act('HOLD'),/ROLE_REQUIRED/);
  await identity(db,f.admin);await assert.rejects(()=>act('REVIEW',1,{verification_reference:'support-case-1'}),/RECENT_MFA_REQUIRED/);await identity(db,f.admin,true);
  await assert.rejects(()=>act('REVIEW'),/VALIDATION_FAILED/);c=await act('REVIEW',1,{verification_reference:'support-case-1'});assert.equal(c.state,'IN_REVIEW');assert.equal(c.version,2);assert.equal(c.verification_reference,'support-case-1');
 });
 await t.test('versioned hold prevents withdrawal and release returns to verified review',async()=>{
  await assert.rejects(()=>act('HOLD',1),/VERSION_CONFLICT/);c=await act('HOLD');assert.equal(c.state,'ON_HOLD');assert.equal(c.hold_reason,'Synthetic review reason');await assert.rejects(()=>act('HOLD'),/STATE_CONFLICT/);await assert.rejects(()=>act('WITHDRAW'),/ROLE_REQUIRED/);
  await identity(db,f.owner,true);await assert.rejects(()=>act('WITHDRAW'),/STATE_CONFLICT/);c=await act('RELEASE_HOLD');assert.equal(c.state,'IN_REVIEW');assert.equal(c.hold_reason,null);await assert.rejects(()=>act('RELEASE_HOLD'),/STATE_CONFLICT/);
 });
 await t.test('scope-safe request replay returns current case; changed input conflicts and revoked role is denied',async()=>{
  assert.equal((await create(payload,key)).version,c.version);await assert.rejects(()=>create({...payload,reason:'Different payload'},key),/IDEMPOTENCY_CONFLICT/);
  await db.exec('reset role');await db.query("update public.memberships set role='AGENT' where tenant_id=$1 and user_id=$2",[f.agency.id,f.owner]);await identity(db,f.owner,true);await assert.rejects(()=>create(payload,key),/ROLE_REQUIRED/);await db.exec('reset role');await db.query("update public.memberships set role='OWNER' where tenant_id=$1 and user_id=$2",[f.agency.id,f.owner]);await identity(db,f.owner,true);
 });
 await t.test('triage replay is current-state safe and never performs deletion or closure',async()=>{
  const k=request(),v=c.version;c=await act('HOLD',v,{},k);const held=c;await act('RELEASE_HOLD');c=await act('HOLD',v,{},k);assert.equal(c.state,'IN_REVIEW');assert.equal(c.version,held.version+1);await assert.rejects(()=>act('HOLD',v,{reason:'Different reason'},k),/IDEMPOTENCY_CONFLICT/);
  for(const action of ['PURGE','APPROVE','ANONYMIZE','CLOSE_AGENCY'])await assert.rejects(()=>act(action),/VALIDATION_FAILED/);
  await assert.rejects(()=>act('REVIEW',c.version,{},request(),f.foreignLead.id),/VALIDATION_FAILED/);
  assert.equal((await db.query('select id from public.leads where id=$1',[f.lead.id])).rows.length,1);assert.equal((await db.query('select id from public.messages where lead_id=$1',[f.lead.id])).rows.length,1);
 });
 await t.test('audit failure rolls back case transition and replay receipt together',async()=>{
  await clearLimit();await db.exec(`reset role;create function private.reject_privacy_audit() returns trigger language plpgsql as $$ begin if new.event_type like 'PRIVACY_%' then raise exception 'AUDIT_REJECTED';end if;return new;end;$$;create trigger reject_privacy_audit before insert on public.activity_events for each row execute function private.reject_privacy_audit();`);await identity(db,f.owner,true);
  const k=request(),version=c.version;await assert.rejects(()=>act('HOLD',version,{},k),/AUDIT_REJECTED/);assert.equal((await db.query<any>('select version from public.privacy_cases where id=$1',[c.id])).rows[0].version,version);assert.equal((await db.query('select id from public.privacy_case_actions where case_id=$1 and case_version=$2',[c.id,version+1])).rows.length,0);
  await db.exec('reset role');assert.equal((await db.query('select * from private.api_requests where request_key=$1',[k])).rows.length,0);await db.exec('drop trigger reject_privacy_audit on public.activity_events;drop function private.reject_privacy_audit()');await identity(db,f.owner,true);c=await act('HOLD',version,{},k);assert.equal(c.version,version+1);c=await act('RELEASE_HOLD');
 });
 await t.test('manager reads do not broaden tenant scope; raw writes and private receipts are denied',async()=>{
  await identity(db,f.other,true);assert.equal((await db.query('select * from public.privacy_cases')).rows.length,0);await assert.rejects(()=>rpc(db,'list_privacy_cases',[f.agency.id]),/MEMBERSHIP_REQUIRED/);await identity(db,f.owner,true);
  assert.equal((await db.query('select * from public.privacy_cases')).rows.length,1);await assert.rejects(()=>db.query("update public.privacy_cases set state='WITHDRAWN' where id=$1",[c.id]),/permission denied/);await assert.rejects(()=>db.query('delete from public.privacy_cases where id=$1',[c.id]),/permission denied/);await assert.rejects(()=>db.query('select * from private.api_requests'),/permission denied/);
 });
 await t.test('withdrawal is owner-only and terminal; holds without verification release to requested',async()=>{
  await identity(db,f.admin,true);await assert.rejects(()=>act('WITHDRAW'),/ROLE_REQUIRED/);await identity(db,f.owner,true);c=await act('WITHDRAW');assert.equal(c.state,'WITHDRAWN');await assert.rejects(()=>act('HOLD'),/STATE_CONFLICT/);
  c=await create({kind:'AGENCY_CLOSURE',lead_id:null,expected_version:f.agency.version,reason:'Synthetic closure request'});c=await act('HOLD');c=await act('RELEASE_HOLD');assert.equal(c.state,'REQUESTED');assert.equal(c.verification_reference,null);
 });
 await t.test('unverified active members cannot directly read agency, leads, messages, cases, activity, membership or notifications',async()=>{
  await db.exec('reset role');const member=(await db.query<{id:string}>('select id from public.memberships where tenant_id=$1 and user_id=$2',[f.agency.id,f.owner])).rows[0].id;await db.query("insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key) values($1,$2,'LEAD_ASSIGNED',$3,$3,'privacy-proof')",[f.agency.id,member,f.lead.id]);await db.query("insert into public.invitations(tenant_id,email,role,state,expires_at,created_by,token_hash,inviter_member_id) values($1,'invite@example.test','AGENT','PENDING',now()+interval '1 day',$2,$3,$4)",[f.agency.id,f.owner,'a'.repeat(64),member]);await identity(db,f.owner,true);assert.equal((await db.query<{n:number}>('select count(*)::int n from public.notifications')).rows[0].n,1);assert.equal((await db.query<{n:number}>('select count(*)::int n from public.invitations')).rows[0].n,1);await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=null where id=$1',[f.owner]);await identity(db,f.owner,true);
  for(const table of ['agencies','memberships','leads','messages','activity_events','notifications','privacy_cases','privacy_case_actions','invitations'])assert.equal((await db.query<{n:number}>(`select count(*)::int n from public.${table}`)).rows[0].n,0,table);
  await assert.rejects(()=>create(payload,key),/AUTH_REQUIRED/);await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=now() where id=$1',[f.owner]);await identity(db,f.owner,true);assert.equal((await db.query('select * from public.privacy_cases')).rows.length,2);
 });
 await t.test('aggregate health is worker-only, read-only and contains neither IDs nor customer text',async()=>{
  await assert.rejects(()=>rpc(db,'worker_health_snapshot'),/permission denied/);await db.exec('reset role;set role anon');await assert.rejects(()=>rpc(db,'worker_health_snapshot'),/permission denied/);await db.exec('reset role');
  await db.query("update private.outbox_events set created_at=now()-interval '30 minutes'");
  const countBefore=(await db.query<{n:number}>('select count(*)::int n from private.request_limits')).rows[0].n;await db.exec('set role service_role');const health=await rpc(db,'worker_health_snapshot');assert.equal(health.database,'REACHABLE');assert.equal(health.privacy_pending,1);assert.equal(health.privacy_execution_available,false);assert.equal(health.cost_amount,null);assert.equal(health.alert,true);assert.ok(health.outbox_lag_seconds>=1800);assert.ok(health.outbox_pending>0);
  const text=JSON.stringify(health);for(const forbidden of [f.owner,f.agency.id,f.lead.id,'Synthetic','example.test','support-case'])assert.ok(!text.includes(forbidden));await db.exec('reset role');assert.equal((await db.query<{n:number}>('select count(*)::int n from private.request_limits')).rows[0].n,countBefore);
 });
 await t.test('health accounts for reserved operations, reconciliation, UTC-month observed tokens and failed jobs',async()=>{
  await db.exec('reset role;set role service_role');await rpc(db,'worker_set_ai_policy',[true,'fixture-only-model',['en'],true,request()]);await db.exec('reset role');await db.query('update public.agencies set ai_enabled=true,processing_approved=true,ai_monthly_limit=100,ai_daily_limit=100 where id=$1',[f.agency.id]);await identity(db,f.owner,true);
  const job=await rpc(db,'submit_analysis',[f.agency.id,f.lead.id,f.lead.version,request(),request()]);await db.exec('reset role;set role service_role');let h=await rpc(db,'worker_health_snapshot');assert.equal(h.reserved_operations,1);assert.equal(h.ai_pending,1);
  await db.exec('reset role');await db.query("update public.ai_jobs set state='FAILED',usage_state='RECONCILE',observed_tokens=37 where id=$1",[job.job_id]);await db.exec('set role service_role');h=await rpc(db,'worker_health_snapshot');assert.equal(h.reconcile_operations,1);assert.equal(h.reserved_operations,0);assert.equal(h.ai_failed,1);assert.equal(h.observed_tokens_month,37);assert.equal(h.alert,true);
  await db.exec('reset role');await db.query("update public.ai_jobs set month_at=(date_trunc('month',now() at time zone 'UTC')-interval '1 month')::date where id=$1",[job.job_id]);await db.exec('set role service_role');assert.equal((await rpc(db,'worker_health_snapshot')).observed_tokens_month,0);
 });
 await t.test('audit records omit intake/review free text and worker private RPC grants remain narrow',async()=>{
  await db.exec('reset role');const rows=(await db.query<any>("select details,reason from public.activity_events where event_type like 'PRIVACY_%'")).rows;assert.ok(rows.length>=8);const notes=(await db.query<any>('select * from public.privacy_case_actions')).rows;assert.ok(notes.length>=8);assert.ok(notes.every(r=>r.reason==='Synthetic review reason'));await identity(db,f.agent,true);assert.equal((await db.query('select * from public.privacy_case_actions')).rows.length,0);await assert.rejects(()=>db.exec("update public.privacy_case_actions set reason='changed'"),/permission denied/);await db.exec('reset role');assert.ok(!JSON.stringify(rows).includes('Synthetic')&&!JSON.stringify(rows).includes('support-case'));await db.exec('set role service_role');await assert.rejects(()=>rpc(db,'list_privacy_cases',[f.agency.id]),/permission denied|AUTH_REQUIRED/);
 });
 await t.test('privacy history cursors page tied timestamps without repeats and malformed cursor pairs are rejected',async()=>{
  await db.exec('reset role');const seeded=(await db.query<{id:string}>("insert into public.leads(tenant_id,full_name,email,source,created_by) select $1,'Privacy page '||n,'privacy-'||n||'@example.test','MANUAL',$2 from generate_series(1,30) n returning id",[f.agency.id,f.owner])).rows;
  for(const row of seeded)await db.query("insert into public.privacy_cases(tenant_id,kind,lead_id,reason,requested_by,created_at) values($1,'LEAD_ERASURE',$2,'Synthetic paging request',$3,'2026-01-01T00:00:00Z')",[f.agency.id,row.id,f.owner]);await identity(db,f.admin);
  const first=(await db.query<any>('select * from public.list_privacy_cases($1)',[f.agency.id])).rows.slice(0,25),last=first.at(-1),next=(await db.query<any>('select * from public.list_privacy_cases($1,$2,$3)',[f.agency.id,last.created_at,last.id])).rows;assert.equal(first.length,25);assert.equal(first.length+next.length,32);assert.equal(new Set([...first,...next].map(c=>c.id)).size,32);await assert.rejects(()=>db.query('select * from public.list_privacy_cases($1,null,$2)',[f.agency.id,last.id]),/VALIDATION_FAILED/);
 });
 }finally{await db.close();}
});
