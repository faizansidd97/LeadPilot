import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localDatabase,identity,rpc,seedPrivacyFixture} from './helpers/local-db.ts';
import {privacyImpactSchema,privacyImpactQuerySchema} from '../src/domain/privacy.ts';
import {readPrivacyImpact} from '../src/server/privacy-impact.ts';
import {ApiError} from '../src/server/http.ts';
import {ClientRequests} from '../../frontend/src/lib/client-workflow.ts';
import {loadPrivacyImpact} from '../../frontend/src/lib/privacy-impact.ts';
const id=()=>crypto.randomUUID(),tenant=id(),caseId=id(),leadId=id(),now=Date.parse('2026-10-10T12:00:00Z');
const snapshot=()=>({tenant_id:tenant,case_id:caseId,case_version:1,case_state:'REQUESTED' as const,kind:'LEAD_ERASURE' as const,
 lead_id:leadId,subject_version:1,as_of:new Date(now).toISOString(),identity_verification_recorded:false,
 intersecting_holds:0,open_tasks:0,active_ai_jobs:0,reconcile_ai_jobs:0,retention_policy_approved:false as const,
 inventory_complete:false as const,execution_available:false as const,counts:{leads:1,messages:1,message_revisions:0,follow_ups:0,
  activity_events:1,ai_jobs:0,ai_analyses:0,reply_drafts:0,draft_feedback:0,notifications:0,privacy_cases:1,privacy_case_actions:0}});

test('impact contract rejects authority/execution claims, raw content and inconsistent counts',()=>{
 assert.equal(privacyImpactSchema.safeParse(snapshot()).success,true);
 for(const value of [{...snapshot(),execution_available:true},{...snapshot(),inventory_complete:true},
  {...snapshot(),retention_policy_approved:true},{...snapshot(),customer:'PRIVATE'},
  {...snapshot(),counts:{...snapshot().counts,messages:-1}},{...snapshot(),open_tasks:1},
  {...snapshot(),active_ai_jobs:1},{...snapshot(),reconcile_ai_jobs:1},{...snapshot(),case_state:'ON_HOLD'},
  {...snapshot(),lead_id:null},{...snapshot(),counts:{...snapshot().counts,leads:0}},
  {...snapshot(),counts:{...snapshot().counts,privacy_cases:0}},{...snapshot(),counts:{...snapshot().counts,secret:1}}])
  assert.equal(privacyImpactSchema.safeParse(value).success,false);
 for(const query of [{},{expected_version:0},{expected_version:1.5},{expected_version:'1',tenant_id:tenant}])assert.equal(privacyImpactQuerySchema.safeParse(query).success,false);
 assert.equal(privacyImpactQuerySchema.parse({expected_version:'1'}).expected_version,1);
});

test('server reader binds the verified tenant/case/version and suppresses raw invalid database content',async()=>{
 const result=await readPrivacyImpact({rpc:async(name,args)=>{
  assert.equal(name,'read_privacy_impact');assert.deepEqual(args,{p_tenant:tenant,p_case:caseId,p_expected_version:1});return {data:snapshot(),error:null};
 }},tenant,caseId,1);assert.equal(result.case_id,caseId);
 for(const data of [{...snapshot(),tenant_id:id()},{...snapshot(),case_id:id()},{...snapshot(),case_version:2},{private:'PRIVATE'}])
  await assert.rejects(readPrivacyImpact({rpc:async()=>({data,error:null})},tenant,caseId,1),e=>e instanceof ApiError&&e.code==='PRIVACY_IMPACT_INVALID'&&!e.message.includes('PRIVATE'));
 await assert.rejects(readPrivacyImpact({rpc:async()=>({data:null,error:{message:'VERSION_CONFLICT'}})},tenant,caseId,1),e=>e instanceof ApiError&&e.status===409);
 await assert.rejects(readPrivacyImpact({rpc:async()=>({data:null,error:{code:'PGRST202',message:'PRIVATE DATABASE CONFIG'}})},tenant,caseId,1),e=>e instanceof ApiError&&e.code==='PRIVACY_IMPACT_UNAVAILABLE'&&!e.message.includes('PRIVATE'));
});

test('client preview enforces scope/version/state/freshness and passes abort signal with user scope',async()=>{
 const requests=new ClientRequests(),ticket=requests.capture(),scope={tenantId:tenant,caseId,caseVersion:1,caseState:'REQUESTED' as const};
 const result=await loadPrivacyImpact(scope,ticket,async(path,options,currentTenant)=>{
  assert.equal(path,'/api/v1/privacy/'+caseId+'/impact?expected_version=1');assert.equal(options.signal,ticket.signal);assert.equal(currentTenant,tenant);return snapshot();
 },()=>now);assert.equal(result.counts.leads,1);
 for(const data of [{...snapshot(),tenant_id:id()},{...snapshot(),case_id:id()},{...snapshot(),case_version:2},
  {...snapshot(),case_state:'WITHDRAWN'},{...snapshot(),as_of:new Date(now-120001).toISOString()},
  {...snapshot(),as_of:new Date(now+30001).toISOString()}])await assert.rejects(loadPrivacyImpact(scope,ticket,async()=>data,()=>now));
});

test('closing/replacing a privacy preview discards deferred old-case completions and suppresses new reads',async()=>{
 const requests=new ClientRequests(),ticket=requests.capture();let complete!:(value:unknown)=>void;
 const pending=loadPrivacyImpact({tenantId:tenant,caseId,caseVersion:1,caseState:'REQUESTED'},ticket,()=>new Promise(resolve=>{complete=resolve;}),()=>now);
 requests.replace();complete(snapshot());await assert.rejects(pending,/scope changed/);
 let called=0;await assert.rejects(loadPrivacyImpact({tenantId:tenant,caseId,caseVersion:1,caseState:'REQUESTED'},ticket,async()=>{called++;return snapshot();},()=>now));assert.equal(called,0);
 requests.close();assert.equal(requests.beginAction(),null);
});

test('actual privacy impact SQL preserves read-only state and enforces current scoped manager authority',async t=>{
 const db=await localDatabase();
 try{
  const f=await seedPrivacyFixture(db);
  const c=await rpc(db,'request_privacy_case',[f.agency.id,{kind:'LEAD_ERASURE',lead_id:f.lead.id,expected_version:f.lead.version,reason:'Synthetic impact request'},id(),id()]);
  const closure=await rpc(db,'request_privacy_case',[f.agency.id,{kind:'AGENCY_CLOSURE',lead_id:null,expected_version:f.agency.version,reason:'Synthetic closure request'},id(),id()]);
  await db.exec('reset role');
  const extra=(await db.query<{id:string}>("insert into public.leads(tenant_id,full_name,email,source,created_by) values($1,'Other local lead','other@example.test','MANUAL',$2) returning id",[f.agency.id,f.owner])).rows[0].id;
  await db.query("insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at) values($1,$2,'INBOUND','MANUAL','SECRET FOREIGN BODY',now())",[f.foreign.id,f.foreignLead.id]);
  await db.query("insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at) values($1,$2,'INTERNAL','MANUAL','SECRET OTHER LEAD',now())",[f.agency.id,extra]);
  await db.query("insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,due_at,created_by) values($1,$2,$3,'INTERNAL','Synthetic private task',now(),$4)",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner]);
  await db.query("insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at) values($1,$2,$3,$4,1,'fixture','fixture','fixture',1,current_date,current_date)",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner]);
  const read=(caseRecord=c,tenantId=f.agency.id,version=caseRecord.version)=>rpc(db,'read_privacy_impact',[tenantId,caseRecord.id,version]);
  await t.test('lead and closure inventories count current scoped records including archived/history data',async()=>{
   await identity(db,f.admin);const preview=privacyImpactSchema.parse(await read());
   assert.equal(preview.counts.leads,1);assert.equal(preview.counts.messages,1);assert.equal(preview.counts.follow_ups,1);
   assert.equal(preview.open_tasks,1);assert.equal(preview.active_ai_jobs,1);assert.equal(preview.counts.privacy_cases,1);
   const agency=privacyImpactSchema.parse(await read(closure));assert.equal(agency.counts.leads,2);assert.equal(agency.counts.messages,2);assert.equal(agency.counts.privacy_cases,2);
   assert.equal(agency.execution_available,false);assert.equal(agency.inventory_complete,false);
   assert.doesNotMatch(JSON.stringify(preview),/SECRET|Synthetic|example.test|lease|snapshot_hash/);
   await db.exec('reset role');await db.query('update public.leads set archived_at=now() where id=$1',[f.lead.id]);await identity(db,f.admin);assert.equal((await read()).counts.leads,1);
  });
  await t.test('manager read works in READ ONLY transaction and does not mutate business/job/audit/receipt/limit rows',async()=>{
   const dump=async()=>{await db.exec('reset role');return (await db.query<{state:unknown}>(`select jsonb_build_object(
    'leads',(select jsonb_agg(to_jsonb(r) order by id) from public.leads r),
    'jobs',(select jsonb_agg(to_jsonb(r) order by id) from public.ai_jobs r),
    'cases',(select jsonb_agg(to_jsonb(r) order by id) from public.privacy_cases r),
    'audit',(select jsonb_agg(to_jsonb(r) order by id) from public.activity_events r),
    'queue',(select jsonb_agg(to_jsonb(r) order by id) from private.outbox_events r),
    'receipts',(select jsonb_agg(to_jsonb(r)) from private.api_requests r),
    'limits',(select jsonb_agg(to_jsonb(r)) from private.request_limits r)) state`)).rows[0].state;};
   const before=await dump();await identity(db,f.owner);await db.exec('begin read only');
   try{privacyImpactSchema.parse(await read());await db.exec('commit');}catch(e){await db.exec('rollback');throw e;}
   assert.deepEqual(await dump(),before);
  });
  await t.test('agent/shared lower role, foreign tenant/case, missing, stale, inactive and unverified access fail',async()=>{
   await identity(db,f.agent);await assert.rejects(read(),/ROLE_REQUIRED/);
   await identity(db,f.owner);await assert.rejects(read(c,f.foreign.id),/ROLE_REQUIRED/);
   await identity(db,f.other);await assert.rejects(read(),/MEMBERSHIP_REQUIRED/);
   await assert.rejects(read(c,f.foreign.id),/NOT_FOUND/);
   await identity(db,f.admin);await assert.rejects(read({...c,id:id()}),/NOT_FOUND/);await assert.rejects(read(c,f.agency.id,2),/VERSION_CONFLICT/);
   await assert.rejects(rpc(db,'read_privacy_impact',[f.agency.id,c.id,null]),/VALIDATION_FAILED/);
   await db.exec('reset role');await db.query('update public.memberships set active=false where user_id=$1 and tenant_id=$2',[f.admin,f.agency.id]);await identity(db,f.admin);await assert.rejects(read(),/MEMBERSHIP_REQUIRED/);
   await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=null where id=$1',[f.owner]);await identity(db,f.owner);await assert.rejects(read(),/AUTH_REQUIRED/);
   await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=now() where id=$1',[f.owner]);
   for(const role of ['anon','service_role']){await db.exec('reset role;set role '+role);await assert.rejects(read(),/permission denied/);}
   await db.exec('reset role');const grants=(await db.query<{anonymous:boolean;user:boolean}>("select has_function_privilege('anon','public.read_privacy_impact(uuid,uuid,integer)','execute') anonymous,has_function_privilege('authenticated','public.read_privacy_impact(uuid,uuid,integer)','execute') \"user\"")).rows[0];assert.deepEqual(grants,{anonymous:false,user:true});
  });
  await t.test('intersecting closure/lead holds, recorded identity and reconciliation remain accurate after review',async()=>{
   await identity(db,f.owner,true);
   const hold=await rpc(db,'triage_privacy_case',[f.agency.id,closure.id,{action:'HOLD',expected_version:1,reason:'Synthetic legal review hold'},id(),id()]);
   const own=await read();assert.equal(own.intersecting_holds,1);assert.equal(own.case_state,'REQUESTED');assert.equal(own.identity_verification_recorded,false);
   const reviewed=await rpc(db,'triage_privacy_case',[f.agency.id,c.id,{action:'REVIEW',expected_version:1,reason:'Synthetic verified request',verification_reference:'PRIVATE SUPPORT REFERENCE'},id(),id()]);
   await assert.rejects(read(),/VERSION_CONFLICT/);assert.equal((await read(reviewed)).identity_verification_recorded,true);
   await db.exec('reset role');await db.query("update public.ai_jobs set state='FAILED',usage_state='RECONCILE' where tenant_id=$1",[f.agency.id]);await identity(db,f.owner);
   const latest=await read(reviewed);assert.equal(latest.active_ai_jobs,0);assert.equal(latest.reconcile_ai_jobs,1);assert.equal((await read(hold)).intersecting_holds,1);
   assert.doesNotMatch(JSON.stringify(latest),/PRIVATE SUPPORT REFERENCE|Synthetic legal/);
  });
 }finally{await db.close();}
});

test('privacy impact migration failure rolls back function/grants and preserves existing privacy workflow',async()=>{
 const db=await localDatabase({through:21});
 try{
  const sql=await readFile(new URL('../supabase/migrations/202610100022_privacy_impact.sql',import.meta.url),'utf8');
  await assert.rejects(db.exec(sql.replace(/commit;\s*$/,'select 1/0;\ncommit;')),/division by zero/);await db.exec('rollback');
  assert.equal((await db.query<{missing:boolean}>("select to_regprocedure('public.read_privacy_impact(uuid,uuid,integer)') is null missing")).rows[0].missing,true);
  const f=await seedPrivacyFixture(db);assert.equal((await rpc(db,'request_privacy_case',[f.agency.id,{kind:'LEAD_ERASURE',lead_id:f.lead.id,expected_version:1,reason:'Synthetic post rollback request'},id(),id()])).version,1);
  await db.exec('reset role');await db.exec(sql);assert.equal((await db.query<{exists:boolean}>("select to_regprocedure('public.read_privacy_impact(uuid,uuid,integer)') is not null exists")).rows[0].exists,true);
 }finally{await db.close();}
});
