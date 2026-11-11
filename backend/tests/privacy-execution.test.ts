import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase,seedPrivacyFixture,identity,rpc} from './helpers/local-db.ts';

async function worker(db:Awaited<ReturnType<typeof localDatabase>>){await db.exec("reset role;set role service_role;select set_config('request.jwt.claim.role','service_role',false)");}
test('privacy execution erases scoped content only after manifest acknowledgement and expires anonymous counts',async()=>{
 const db=await localDatabase();try{
 const f=await seedPrivacyFixture(db),key=crypto.randomUUID();
 const c=await rpc(db,'request_privacy_case',[f.agency.id,{kind:'LEAD_ERASURE',lead_id:f.lead.id,expected_version:1,reason:'Private reason customer'},crypto.randomUUID(),crypto.randomUUID()]);
 const reviewed=await rpc(db,'triage_privacy_case',[f.agency.id,c.id,{action:'REVIEW',expected_version:1,reason:'Private review note',verification_reference:'Private identity reference'},crypto.randomUUID(),crypto.randomUUID()]);
 const payload={expected_case_version:reviewed.version,expected_subject_version:1,expected_policy_version:1,confirm:'ANONYMIZE'};
 await assert.rejects(rpc(db,'prepare_privacy_execution',[f.agency.id,c.id,payload,key,crypto.randomUUID()]),/PRIVACY_DISABLED/);
 await db.exec('reset role;update private.privacy_policy set enabled=true');await identity(db,f.owner,true);
 const j=await rpc(db,'prepare_privacy_execution',[f.agency.id,c.id,payload,key,crypto.randomUUID()]);
 assert.equal(j.state,'PENDING');assert.equal((await rpc(db,'prepare_privacy_execution',[f.agency.id,c.id,payload,key,crypto.randomUUID()])).id,j.id);
 assert.equal((await db.query('select * from public.leads where id=$1',[f.lead.id])).rows.length,0);
 await db.exec('reset role');await assert.rejects(db.query("update public.leads set notes='Late private text' where id=$1",[f.lead.id]),/PRIVACY_FROZEN/);
 assert.equal((await db.query<{body:string}>('select body from public.messages where lead_id=$1',[f.lead.id])).rows[0].body,'Synthetic private message');
 await worker(db);const claim=await rpc(db,'worker_claim_privacy');assert.equal(JSON.parse(claim.manifest_text).lead_ids[0],f.lead.id);const digest=createHash('sha256').update(claim.manifest_text).digest('hex');
 await assert.rejects(rpc(db,'worker_apply_privacy',[j.id,claim.lease,null]),/PRIVACY_MANIFEST_REQUIRED/);
 const result=await rpc(db,'worker_apply_privacy',[j.id,claim.lease,digest]);assert.equal(result.state,'ANONYMIZED');assert.equal(result.processed,1);
 assert.equal((await rpc(db,'worker_apply_privacy',[j.id,claim.lease,digest])).state,'STALE');
 await db.exec('reset role');assert.equal((await db.query('select * from public.messages where lead_id=$1',[f.lead.id])).rows.length,0);
 const l=(await db.query<any>('select * from public.leads where id=$1',[f.lead.id])).rows[0];assert.equal(l.email,'redacted@example.invalid');assert.equal(l.phone,null);assert.equal(l.notes,'');assert.equal(l.full_name,'Anonymous record');
 assert.equal((await db.query<any>('select * from public.leads where id=$1',[f.foreignLead.id])).rows[0].email,'foreign@example.test');
 await identity(db,f.owner,true);const status=await rpc(db,'read_privacy_execution',[f.agency.id,c.id]);assert.deepEqual(status.history,{leads:1,messages:1,tasks:0});assert.equal(status.job.state,'ANONYMIZED');
 assert.equal(Date.parse(status.job.history_expires_at)-Date.parse(status.job.completed_at),30*24*60*60*1000);
 assert.doesNotMatch(JSON.stringify(status),/Synthetic|Private|example.test/);
 await db.exec("reset role;update private.privacy_jobs set history_expires_at=statement_timestamp()-interval '1 second'");await worker(db);
 assert.deepEqual(await rpc(db,'worker_expire_privacy'),{expired:1});assert.deepEqual(await rpc(db,'worker_expire_privacy'),{expired:0});
 await identity(db,f.owner);const expired=await rpc(db,'read_privacy_execution',[f.agency.id,c.id]);assert.equal(expired.history,null);assert.equal(expired.job.state,'EXPIRED');
 }finally{await db.close();}
});

async function preparedFixture(kind='LEAD_ERASURE'){
 const db=await localDatabase(),f=await seedPrivacyFixture(db);await db.exec('reset role;update private.privacy_policy set enabled=true');await identity(db,f.owner,true);
 const c=await rpc(db,'request_privacy_case',[f.agency.id,{kind,lead_id:kind==='LEAD_ERASURE'?f.lead.id:null,expected_version:1,reason:'Synthetic privacy request'},crypto.randomUUID(),crypto.randomUUID()]);
 const review=await rpc(db,'triage_privacy_case',[f.agency.id,c.id,{action:'REVIEW',expected_version:1,reason:'Synthetic review',verification_reference:'External reference'},crypto.randomUUID(),crypto.randomUUID()]);
 const body={expected_case_version:review.version,expected_subject_version:1,expected_policy_version:1,confirm:'ANONYMIZE'};
 return {db,f,c,body,prepare:()=>rpc(db,'prepare_privacy_execution',[f.agency.id,c.id,body,crypto.randomUUID(),crypto.randomUUID()])};
}
async function applyClaim(db:Awaited<ReturnType<typeof localDatabase>>){await worker(db);const claim=await rpc(db,'worker_claim_privacy');return {claim,apply:()=>rpc(db,'worker_apply_privacy',[claim.id,claim.lease,createHash('sha256').update(claim.manifest_text).digest('hex')])};}

test('privacy prepare denies stale versions, lower/foreign roles, missing MFA, unresolved AI, imports and intersecting holds',async()=>{
 const {db,f,c,body,prepare}=await preparedFixture();try{
 await identity(db,f.admin,true);await assert.rejects(prepare(),/ROLE_REQUIRED/);
 await identity(db,f.agent,true);await assert.rejects(prepare(),/ROLE_REQUIRED/);
 await identity(db,f.other,true);await assert.rejects(prepare(),/MEMBERSHIP_REQUIRED/);
 await identity(db,f.owner,false);await assert.rejects(prepare(),/RECENT_MFA_REQUIRED/);
 await identity(db,f.owner,true);body.expected_subject_version=2;await assert.rejects(prepare(),/VERSION_CONFLICT/);body.expected_subject_version=1;
 const held=await rpc(db,'request_privacy_case',[f.agency.id,{kind:'AGENCY_CLOSURE',lead_id:null,expected_version:1,reason:'Hold overlapping agency'},crypto.randomUUID(),crypto.randomUUID()]);
 await rpc(db,'triage_privacy_case',[f.agency.id,held.id,{action:'HOLD',expected_version:1,reason:'Synthetic hold reason'},crypto.randomUUID(),crypto.randomUUID()]);
 await assert.rejects(prepare(),/PRIVACY_ON_HOLD/);await rpc(db,'triage_privacy_case',[f.agency.id,held.id,{action:'RELEASE_HOLD',expected_version:2,reason:'Release synthetic hold'},crypto.randomUUID(),crypto.randomUUID()]);
 await db.exec('reset role');const job=(await db.query<any>("insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at) values($1,$2,$3,$4,1,'fixture','fixture','fixture',1,current_date,current_date) returning id",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner])).rows[0];
 await identity(db,f.owner,true);await assert.rejects(prepare(),/PRIVACY_PROCESSING_PENDING/);
 await db.exec("reset role");await db.query("update public.ai_jobs set state='FAILED',usage_state='RECONCILE' where id=$1",[job.id]);await identity(db,f.owner,true);await assert.rejects(prepare(),/PRIVACY_PROCESSING_PENDING/);
 await db.exec('reset role');await db.query('delete from public.ai_jobs where id=$1',[job.id]);
 const imp=(await db.query<any>("insert into private.lead_imports(tenant_id,actor_id,request_key,payload_hash,total) values($1,$2,$3,'hash',1) returning id",[f.agency.id,f.owner,crypto.randomUUID()])).rows[0];
 await db.query("insert into private.lead_import_rows(tenant_id,import_id,row_index,payload) values($1,$2,1,'{\"full_name\":\"Unattributed customer\"}')",[f.agency.id,imp.id]);
 await identity(db,f.owner,true);await assert.rejects(prepare(),/PRIVACY_IMPORT_REVIEW_REQUIRED/);
 await db.exec('reset role');assert.equal((await db.query('select * from private.privacy_jobs')).rows.length,0);assert.equal((await db.query('select body from public.messages where lead_id=$1',[f.lead.id])).rows.length,1);
 await db.exec('set role anon');await assert.rejects(rpc(db,'worker_claim_privacy'),/permission denied/);await assert.rejects(db.query('select * from private.privacy_context'),/permission denied/);
 }finally{await db.close();}
});

test('cleanup removes messages, revisions, tasks, drafts, AI context, matching retries/imports and website provenance; unrelated records survive',async()=>{
 const {db,f,prepare}=await preparedFixture();try{
 await db.exec('reset role');
 const msg=(await db.query<any>('select * from public.messages where lead_id=$1',[f.lead.id])).rows[0];
 await db.query("insert into public.message_revisions(tenant_id,lead_id,message_id,previous_body,revision,reason,actor_id) values($1,$2,$3,'PRIVATE_REVISION',1,'Private revision reason',$4)",[f.agency.id,f.lead.id,msg.id,f.owner]);
 const task=(await db.query<any>("insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,notes,due_at,created_by) values($1,$2,$3,'CALL','PRIVATE_TASK','PRIVATE_NOTES',now(),$4) returning *",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner])).rows[0];
 const job=(await db.query<any>("insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,state,usage_state,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at) values($1,$2,$3,$4,'SUCCEEDED','CONSUMED',1,'fixture','fixture','fixture',1,current_date,current_date) returning id",[f.agency.id,f.lead.id,f.members[f.agent+f.agency.id],f.owner])).rows[0];
 await db.query("insert into private.ai_context values($1,'{\"private\":\"PRIVATE_AI_CONTEXT\"}','hash')",[job.id]);
 const draft=(await db.query<any>("insert into public.reply_drafts(tenant_id,lead_id,job_id,input_version,state,freshness,original_text,working_text,language,tone,outline,model,prompt_version,schema_version,observed_tokens,latency_ms) values($1,$2,$3,1,'GENERATED','CURRENT','PRIVATE_DRAFT','PRIVATE_WORKING','en','PROFESSIONAL','{}','fixture','fixture','fixture',1,1) returning id",[f.agency.id,f.lead.id,job.id])).rows[0];
 await db.query("insert into public.draft_feedback(tenant_id,lead_id,draft_id,actor_id,content_version,category,comment) values($1,$2,$3,$4,1,'USEFUL','PRIVATE_FEEDBACK')",[f.agency.id,f.lead.id,draft.id,f.owner]);
 await db.query("insert into private.api_requests values($1,'lead-save',$2,'hash',$3,$4,now())",[f.owner,crypto.randomUUID(),f.agency.id,JSON.stringify({id:f.lead.id,full_name:'PRIVATE_RECEIPT'})]);
 await db.query("insert into private.api_requests values($1,'unrelated-save',$2,'hash',$3,'{\"value\":\"UNRELATED_RECEIPT\"}',now())",[f.owner,crypto.randomUUID(),f.agency.id]);
 const website=(await db.query<any>("insert into private.website_integrations(tenant_id,name,secret_cipher,secret_aad,secret_hash,created_by) values($1,'Website','cipher','aad',$2,$3) returning id",[f.agency.id,'a'.repeat(64),f.owner])).rows[0];
 await db.query("insert into private.intake_events values($1,$2,'PRIVATE_EXTERNAL_EVENT',$3,$4,now())",[website.id,f.agency.id,'b'.repeat(64),f.lead.id]);
 const imp=(await db.query<any>("insert into private.lead_imports(tenant_id,actor_id,request_key,payload_hash,total) values($1,$2,$3,'hash',1) returning id",[f.agency.id,f.owner,crypto.randomUUID()])).rows[0];
 await db.query("insert into private.lead_import_rows(tenant_id,import_id,row_index,lead_id,state,payload,errors) values($1,$2,1,$3,'CREATED','{\"name\":\"PRIVATE_IMPORT\"}','{\"body\":\"PRIVATE_IMPORT_ERROR\"}')",[f.agency.id,imp.id,f.lead.id]);
 await identity(db,f.owner,true);await prepare();const run=await applyClaim(db);await run.apply();await db.exec('reset role');
 for(const table of ['messages','message_revisions','follow_ups','ai_jobs','reply_drafts','draft_feedback'])assert.equal((await db.query('select * from public.'+table+' where lead_id=$1',[f.lead.id])).rows.length,0,table);
 assert.equal((await db.query('select * from private.ai_context')).rows.length,0);
 assert.deepEqual((await db.query<any>("select response from private.api_requests where operation='lead-save'")).rows[0].response,{privacy_redacted:true});
 assert.equal((await db.query<any>("select response from private.api_requests where operation='unrelated-save'")).rows[0].response.value,'UNRELATED_RECEIPT');
 assert.equal((await db.query('select * from private.intake_events')).rows.length,0);assert.equal((await db.query('select * from private.privacy_intake_barriers')).rows.length,1);
 await assert.rejects(db.query("insert into private.intake_events values($1,$2,'PRIVATE_EXTERNAL_EVENT',$3,$4,now())",[website.id,f.agency.id,'b'.repeat(64),f.lead.id]),/PRIVACY_FROZEN/);
 assert.deepEqual((await db.query<any>('select payload,errors from private.lead_import_rows')).rows[0],{payload:null,errors:{}});
 await assert.rejects(db.query("insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at) values($1,$2,'INBOUND','MANUAL','Late copy',now())",[f.agency.id,f.lead.id]),/PRIVACY_FROZEN/);
 assert.equal((await db.query<any>('select * from public.leads where id=$1',[f.foreignLead.id])).rows[0].full_name,'Foreign lead');assert.ok(task.id);
 }finally{await db.close();}
});

test('failure during cleanup rolls back all content removal and progress, then original lease can retry',async()=>{
 const {db,f,prepare}=await preparedFixture();try{
 await prepare();const run=await applyClaim(db);await db.exec("reset role;create function private.fail_privacy_test() returns trigger language plpgsql as $$begin raise exception 'INJECTED_CLEANUP_FAILURE';end;$$;create trigger fail_privacy_test before update on public.leads for each row execute function private.fail_privacy_test()");
 await worker(db);await assert.rejects(run.apply(),/INJECTED_CLEANUP_FAILURE/);await db.exec('reset role');
 assert.equal((await db.query('select * from public.messages where lead_id=$1',[f.lead.id])).rows.length,1);assert.equal((await db.query<any>('select * from private.privacy_subjects')).rows[0].state,'PENDING');assert.equal((await db.query('select * from private.privacy_context')).rows.length,0);
 await db.exec('drop trigger fail_privacy_test on public.leads');await worker(db);assert.equal((await run.apply()).state,'ANONYMIZED');
 }finally{await db.close();}
});

test('agency closure revokes scoped memberships/integrations while preserving shared Auth and foreign agency',async()=>{
 const {db,f,c,prepare}=await preparedFixture('AGENCY_CLOSURE');try{
 await prepare();const run=await applyClaim(db);assert.equal((await run.apply()).state,'ANONYMIZED');await db.exec('reset role');
 assert.equal((await db.query<any>('select * from public.agencies where id=$1',[f.agency.id])).rows[0].name,'Closed agency');
 assert.equal((await db.query('select * from public.memberships where tenant_id=$1 and active',[f.agency.id])).rows.length,0);
 assert.equal((await db.query('select * from auth.users where id=$1',[f.owner])).rows.length,1);
 await identity(db,f.owner);assert.equal((await db.query('select * from public.leads where id=$1',[f.foreignLead.id])).rows.length,0); // Shared user is an unassigned foreign AGENT.
 await identity(db,f.other);assert.equal((await db.query('select * from public.leads where id=$1',[f.foreignLead.id])).rows.length,1);
 await db.exec('reset role');assert.equal((await db.query<any>('select state from public.privacy_cases where id=$1',[c.id])).rows[0].state,'CLOSED');
 }finally{await db.close();}
});

test('restore replay blocks API identity/RLS until the exact independent checkpoint has applied',async()=>{
 const {db,f,c,prepare}=await preparedFixture();try{
 // Capture a restored older customer row before preparation; independent manifest survives separately.
 await prepare();const run=await applyClaim(db);const text=run.claim.manifest_text;await run.apply();
 await worker(db);const checkpoint='c'.repeat(64);await rpc(db,'worker_privacy_restore_begin',[checkpoint,1]);
 await identity(db,f.owner,true);assert.equal((await db.query('select * from public.leads')).rows.length,0);await assert.rejects(rpc(db,'read_privacy_execution',[f.agency.id,c.id]),/PRIVACY_RESTORE_REQUIRED/);
 await db.exec('reset role');
 await db.query('insert into private.privacy_context values(txid_current(),$1,$2)',[f.agency.id,run.claim.id]); // Must be in one transaction to authorize a restored copy.
 await db.exec('delete from private.privacy_context;begin');await db.query('insert into private.privacy_context values(txid_current(),$1,$2)',[f.agency.id,run.claim.id]);
 await db.query("update public.leads set full_name='RESTORED_IDENTITY',email='restore@example.test' where id=$1",[f.lead.id]);await db.query("insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at) values($1,$2,'INBOUND','MANUAL','RESTORED_PRIVATE_BODY',now())",[f.agency.id,f.lead.id]);await db.exec('delete from private.privacy_context;commit');
 await worker(db);await assert.rejects(rpc(db,'worker_privacy_restore_finish',[checkpoint]),/PRIVACY_RESTORE_REQUIRED/);
 await rpc(db,'worker_privacy_restore_apply',[checkpoint,text]);await rpc(db,'worker_privacy_restore_apply',[checkpoint,text]);
 assert.deepEqual(await rpc(db,'worker_privacy_restore_finish',[checkpoint]),{blocked:false});await db.exec('reset role');
 assert.equal((await db.query('select * from public.messages where lead_id=$1',[f.lead.id])).rows.length,0);assert.equal((await db.query<any>('select email from public.leads where id=$1',[f.lead.id])).rows[0].email,'redacted@example.invalid');
 assert.equal((await db.query('select * from private.privacy_history')).rows.length,0);
 }finally{await db.close();}
});

test('actual older database dump/load replays an independent manifest even when the request did not exist in the backup',async()=>{
 const original=await localDatabase();let restored:PGlite|null=null;try{
 const f=await seedPrivacyFixture(original);await original.exec('reset role;update private.privacy_policy set enabled=true');
 const backup=await original.dumpDataDir('none');
 await identity(original,f.owner,true);const c=await rpc(original,'request_privacy_case',[f.agency.id,{kind:'LEAD_ERASURE',lead_id:f.lead.id,expected_version:1,reason:'Backup replay test'},crypto.randomUUID(),crypto.randomUUID()]);
 await rpc(original,'triage_privacy_case',[f.agency.id,c.id,{action:'REVIEW',expected_version:1,reason:'Backup review test',verification_reference:'External test ref'},crypto.randomUUID(),crypto.randomUUID()]);
 await rpc(original,'prepare_privacy_execution',[f.agency.id,c.id,{expected_case_version:2,expected_subject_version:1,expected_policy_version:1,confirm:'ANONYMIZE'},crypto.randomUUID(),crypto.randomUUID()]);
 const run=await applyClaim(original);const independent=run.claim.manifest_text;await run.apply();
 restored=new PGlite({loadDataDir:backup});await worker(restored);await rpc(restored,'worker_privacy_restore_begin',['d'.repeat(64),1]);
 await rpc(restored,'worker_privacy_restore_apply',['d'.repeat(64),independent]);await rpc(restored,'worker_privacy_restore_finish',['d'.repeat(64)]);
 await restored.exec('reset role');assert.equal((await restored.query('select * from public.messages where lead_id=$1',[f.lead.id])).rows.length,0);
 assert.equal((await restored.query<any>('select email from public.leads where id=$1',[f.lead.id])).rows[0].email,'redacted@example.invalid');
 assert.equal((await restored.query<any>('select email from public.leads where id=$1',[f.foreignLead.id])).rows[0].email,'foreign@example.test');
 await identity(restored,f.owner);assert.equal((await restored.query('select * from public.leads where id=$1',[f.lead.id])).rows.length,0);
 }finally{await restored?.close();await original.close();}
});

test('26-subject closure is bounded to 25 per lease, stale lease is fenced and final cleanup finishes only after all subjects',async()=>{
 const {db,f,prepare}=await preparedFixture('AGENCY_CLOSURE');try{
 await db.exec('reset role');for(let i=0;i<25;i++)await db.query("insert into public.leads(tenant_id,full_name,email,source,created_by) values($1,'Other synthetic lead','other@example.test','MANUAL',$2)",[f.agency.id,f.owner]);
 await identity(db,f.owner,true);await prepare();const first=await applyClaim(db);assert.equal((await first.apply()).state,'PENDING');
 await db.exec('reset role');assert.equal((await db.query('select * from private.privacy_subjects where state=\'ANONYMIZED\'')).rows.length,25);assert.equal((await db.query('select * from public.memberships where tenant_id=$1 and active',[f.agency.id])).rows.length,3);
 const second=await applyClaim(db);assert.equal((await first.apply()).state,'STALE');assert.equal((await second.apply()).state,'ANONYMIZED');
 await db.exec('reset role');assert.equal((await db.query('select * from private.privacy_subjects where state=\'PENDING\'')).rows.length,0);assert.equal((await db.query('select * from public.memberships where tenant_id=$1 and active',[f.agency.id])).rows.length,0);
 }finally{await db.close();}
});

test('agency closure includes an already-anonymized lead without reopening its original execution',async()=>{
 const {db,f,c,prepare}=await preparedFixture();try{
 await prepare();await (await applyClaim(db)).apply();await identity(db,f.owner,true);
 const closure=await rpc(db,'request_privacy_case',[f.agency.id,{kind:'AGENCY_CLOSURE',lead_id:null,expected_version:1,reason:'Close remaining agency'},crypto.randomUUID(),crypto.randomUUID()]);
 await rpc(db,'triage_privacy_case',[f.agency.id,closure.id,{action:'REVIEW',expected_version:1,reason:'Closure review',verification_reference:'Closure identity ref'},crypto.randomUUID(),crypto.randomUUID()]);
 await rpc(db,'prepare_privacy_execution',[f.agency.id,closure.id,{expected_case_version:2,expected_subject_version:1,expected_policy_version:1,confirm:'ANONYMIZE'},crypto.randomUUID(),crypto.randomUUID()]);
 await (await applyClaim(db)).apply();await db.exec('reset role');assert.equal((await db.query<any>('select state from public.privacy_cases where id=$1',[c.id])).rows[0].state,'WITHDRAWN');
 }finally{await db.close();}
});

test('migration 024 rolls back all added tables/guards on failure and can then apply cleanly',async()=>{
 const {readFile}=await import('node:fs/promises');const {migrationDir}=await import('./helpers/local-db.ts');const source=await readFile(new URL('20261019122219_privacy_anonymization.sql',migrationDir),'utf8');
 const db=await localDatabase({through:23});try{
 const f=await seedPrivacyFixture(db);await db.exec('reset role');
 await assert.rejects(db.exec(source.replace(/^commit;$/m,"select 1/0;commit;")));await db.exec('rollback');
 assert.equal((await db.query<any>("select to_regclass('private.privacy_jobs') r")).rows[0].r,null);assert.equal((await db.query<any>('select email from public.leads where id=$1',[f.lead.id])).rows[0].email,'synthetic@example.test');
 await db.exec(source);await identity(db,f.owner);assert.equal((await db.query('select * from public.leads where id=$1',[f.lead.id])).rows.length,1);
 }finally{await db.close();}
});
