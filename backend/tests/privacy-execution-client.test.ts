import test from 'node:test';
import assert from 'node:assert/strict';
import {ClientRequests} from '../../frontend/src/lib/client-workflow.ts';
import {PrivacySaveRecovery} from '../../frontend/src/lib/privacy-workflow.ts';
import {beginPrivacyExecution,readPrivacyExecution} from '../../frontend/src/lib/privacy-execution.ts';
const tenant=crypto.randomUUID(),caseId=crypto.randomUUID(),jobId=crypto.randomUUID();
const input={expected_case_version:2,expected_subject_version:1,expected_policy_version:1,confirm:'ANONYMIZE'};
const status=()=>({policy_enabled:true,policy_version:1,history_days:30,job:{id:jobId,state:'PENDING',prepared_at:new Date().toISOString(),completed_at:null,history_expires_at:null,expired_at:null,total:1,processed:0},history:null});

test('lost prepare acknowledgement reuses original payload/key; acknowledged prepare recovers by reads only',async()=>{
 const recovery=new PrivacySaveRecovery(),requests=new ClientRequests(),calls:{method:string;key?:string;body?:BodyInit|null}[]=[];let writes=0,reads=0,published=0;
 const read=async(_path:string,options:RequestInit,_tenant:string,key?:string)=>{calls.push({method:options.method??'GET',key,body:options.body});if(options.method){if(++writes===1)throw Object.assign(Error('Lost acknowledgement'),{status:503});return {id:jobId,case_id:caseId,state:'PENDING'};}if(++reads===1)throw Object.assign(Error('Read unavailable'),{status:503});return status();};
 const original={...input};await assert.rejects(beginPrivacyExecution(recovery,requests.capture(),read,tenant,caseId,original,()=>{published++;}));original.expected_subject_version=9;
 await assert.rejects(recovery.recover(requests.capture()));assert.equal(recovery.pending,'refresh');await recovery.recover(requests.capture());assert.equal(writes,2);assert.equal(published,1);assert.equal(recovery.pending,null);
 assert.equal(calls[0].key,calls[1].key);assert.equal(calls[0].body,calls[1].body);assert.equal(JSON.parse(String(calls[1].body)).expected_subject_version,1);
});
test('recent MFA failure retains original preparation while current role denial discards it',async()=>{
 for(const [code,retained] of [['RECENT_MFA_REQUIRED',true],['ROLE_REQUIRED',false]]){
 const r=new PrivacySaveRecovery();await assert.rejects(beginPrivacyExecution(r,new ClientRequests().capture(),async()=>{throw Object.assign(Error('Verify access'),{status:403,code});},tenant,caseId,input,()=>{}));assert.equal(!!r.pending,retained);
 }
});
test('malformed/cross-case receipts cannot be accepted; mismatched progress cannot publish',async()=>{
 for(const receipt of [{id:jobId,case_id:crypto.randomUUID(),state:'PENDING'},{id:jobId,case_id:caseId,state:'PENDING',customer:'PRIVATE'}]){
 const r=new PrivacySaveRecovery();await assert.rejects(beginPrivacyExecution(r,new ClientRequests().capture(),async()=>receipt,tenant,caseId,input,()=>assert.fail('must not publish')));assert.equal(r.pending,'write');
 }
 const r=new PrivacySaveRecovery();await assert.rejects(beginPrivacyExecution(r,new ClientRequests().capture(),async(_p,o)=>o.method?{id:jobId,case_id:caseId,state:'PENDING'}:{...status(),job:{...status().job,id:crypto.randomUUID()}},tenant,caseId,input,()=>assert.fail('must not publish')));assert.equal(r.pending,'refresh');
});
test('closed/deferred read cannot publish; invalid progress and unexpected fields fail safely',async()=>{
 const r=new ClientRequests(),ticket=r.capture();let resolve!:(v:unknown)=>void;
 const pending=readPrivacyExecution(ticket,()=>new Promise(done=>{resolve=done;}),tenant,caseId);r.close();resolve(status());await assert.rejects(pending,{name:'AbortError'});
 for(const value of [{...status(),history_days:31},{...status(),job:{...status().job,processed:2}},{...status(),token:'PRIVATE'},{...status(),job:{...status().job,state:'EXPIRED'},history:{leads:1,messages:0,tasks:0}}])await assert.rejects(readPrivacyExecution(new ClientRequests().capture(),async()=>value,tenant,caseId));
});
