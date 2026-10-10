import test from 'node:test';
import assert from 'node:assert/strict';
import {localDatabase,identity,rpc,seedPrivacyFixture} from './helpers/local-db.ts';
import type {RequestTicket} from '../../frontend/src/lib/client-workflow.ts';
const {ClientRequests}=await import(new URL('../../frontend/src/lib/client-workflow.ts',import.meta.url).href);
const {PrivacySaveRecovery,beginPrivacySave,loadPrivacyCases,loadPrivacyHistory,searchPrivacyLeads}=await import(new URL('../../frontend/src/lib/privacy-workflow.ts',import.meta.url).href);
const tenant=crypto.randomUUID(),caseId=crypto.randomUUID(),leadId=crypto.randomUUID();
const failure=(status=503)=>Object.assign(Error('Synthetic failure'),{status});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return {promise,resolve};};
const row=(overrides={})=>({id:caseId,tenant_id:tenant,kind:'LEAD_ERASURE',lead_id:leadId,state:'REQUESTED',reason:'Synthetic privacy request',version:1,
 verification_reference:null,hold_reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),...overrides});
const page=(cases=[row()])=>({cases,execution_available:false,next_cursor:null});
const request=()=>({kind:'request' as const,body:{kind:'LEAD_ERASURE',lead_id:leadId,expected_version:3,reason:'Synthetic privacy request'}});

test('privacy case read binds user tenant, signal and encoded cursor before publication',async()=>{
 const ticket=new ClientRequests().capture(),calls:any[]=[];
 const result=await loadPrivacyCases(ticket,async(...args:any[])=>{calls.push(args);return page();},tenant,'cursor/+');
 assert.equal(result.cases[0].id,caseId);assert.equal(calls[0][0],'/api/v1/privacy?cursor=cursor%2F%2B');assert.equal(calls[0][1].signal,ticket.signal);assert.equal(calls[0][2],tenant);
 assert.equal(Object.hasOwn(result.cases[0],'tenant_id'),false);
});
test('privacy list rejects malformed, foreign, duplicate and execution-enabled records',async()=>{
 for(const value of [page([row({tenant_id:crypto.randomUUID()})]),page([row({version:0})]),page([row({state:'ON_HOLD'})]),page([row({kind:'AGENCY_CLOSURE'})]),page([row(),row()]),{...page(),execution_available:true},{cases:[],execution_available:false},page([row({updated_at:'invalid'})])])
  await assert.rejects(loadPrivacyCases(new ClientRequests().capture(),async()=>value,tenant),{status:503});
});
test('effect replay or closing a case fences late privacy list and history even when abort is ignored',async()=>{
 for(const kind of ['cases','history']){
  const requests=new ClientRequests(),ticket=requests.capture(),pending=deferred();let published=false;
  const work=(kind==='cases'?loadPrivacyCases(ticket,async()=>pending.promise,tenant):loadPrivacyHistory(ticket,async()=>pending.promise,tenant,caseId)).then(()=>{published=true;});
  requests.close();requests.replace();pending.resolve(kind==='cases'?page():{actions:[],next_cursor:null});await assert.rejects(work,{name:'AbortError'});assert.equal(published,false);
 }
});
test('review history validates its selected-case request and distinguishes malformed from empty',async()=>{
 const ticket=new ClientRequests().capture(),actions=[{id:crypto.randomUUID(),action:'HOLD',case_version:2,reason:'Synthetic hold',created_at:new Date().toISOString()}],calls:any[]=[];
 const result=await loadPrivacyHistory(ticket,async(...args:any[])=>{calls.push(args);return {actions,next_cursor:null};},tenant,caseId);
 assert.equal(calls[0][0],'/api/v1/privacy/'+caseId);assert.equal(calls[0][1].signal,ticket.signal);assert.equal(result.actions.length,1);
 for(const bad of [{actions:[{...actions[0],case_version:1}],next_cursor:null},{actions:[{...actions[0],action:'DELETE'}],next_cursor:null},{actions}])await assert.rejects(loadPrivacyHistory(ticket,async()=>bad,tenant,caseId),{status:503});
 assert.deepEqual((await loadPrivacyHistory(ticket,async()=>({actions:[],next_cursor:null}),tenant,caseId)).actions,[]);
});
test('lead search binds query/archive mode and rejects foreign or wrong-mode choices',async()=>{
 const ticket=new ClientRequests().capture(),lead={id:leadId,tenant_id:tenant,full_name:'Synthetic lead',version:3,archived_at:null},calls:any[]=[];
 const result=await searchPrivacyLeads(ticket,async(...args:any[])=>{calls.push(args);return {leads:[lead],pagination:{next_cursor:null}};},tenant,'A&B',false);
 assert.equal(new URL(calls[0][0],'https://example.test').searchParams.get('q'),'A&B');assert.equal(result.leads[0].version,3);
 for(const bad of [{...lead,tenant_id:crypto.randomUUID()},{...lead,archived_at:new Date().toISOString()},{...lead,version:0}])await assert.rejects(searchPrivacyLeads(ticket,async()=>({leads:[bad],pagination:{next_cursor:null}}),tenant,'',false),{status:503});
 await assert.rejects(searchPrivacyLeads(ticket,async()=>({leads:[lead],pagination:{next_cursor:null}}),tenant,'',true),{status:503});
});
test('replaced lead search cannot publish choices from a former query',async()=>{
 const requests=new ClientRequests(),ticket=requests.beginAction()!,pending=deferred();const work=searchPrivacyLeads(ticket,async()=>pending.promise,tenant,'first',false);requests.replace();pending.resolve({leads:[],pagination:{next_cursor:null}});await assert.rejects(work,{name:'AbortError'});
});
test('lost privacy acknowledgement retries the original payload and key despite edited caller input',async()=>{
 const requests=new ClientRequests(),recovery=new PrivacySaveRecovery(),operation=request(),calls:any[]=[];let writes=0,completed=0;
 const read=async(path:string,options:RequestInit,scope:string,key?:string)=>{calls.push({path,options,scope,key});if(++writes===1)throw failure();return row();};
 await assert.rejects(beginPrivacySave(recovery,requests.capture(),read,tenant,operation,async()=>{},()=>{completed++;}),{status:503});assert.equal(recovery.pending,'write');
 operation.body.reason='Caller edited input';operation.body.expected_version=10;
 await recovery.recover(requests.capture());assert.equal(calls[0].options.body,calls[1].options.body);assert.equal(calls[0].key,calls[1].key);assert.equal(calls[1].scope,tenant);assert.equal(completed,1);assert.equal(recovery.pending,null);
});
test('acknowledged privacy writes recover a failed refresh with reads only and delayed form completion',async()=>{
 const requests=new ClientRequests(),recovery=new PrivacySaveRecovery();let writes=0,loads=0,completed=0;
 const read=async(_path:string,options:RequestInit)=>{if(options.method){writes++;return row();}if(++loads===1)throw failure();return page();};
 await assert.rejects(beginPrivacySave(recovery,requests.capture(),read,tenant,request(),async(ticket:RequestTicket)=>{await loadPrivacyCases(ticket,read,tenant);},()=>{completed++;}),{status:503});
 assert.equal(recovery.pending,'refresh');assert.equal(completed,0);await recovery.recover(requests.capture());assert.equal(writes,1);assert.equal(loads,2);assert.equal(completed,1);
});
test('malformed or foreign save receipts remain uncertain with the original replay key',async()=>{
 for(const receipt of [row({tenant_id:crypto.randomUUID()}),row({lead_id:crypto.randomUUID()}),row({state:'WITHDRAWN'}),row({version:2}),{}]){
  const recovery=new PrivacySaveRecovery(),ticket=new ClientRequests().capture();let completed=false;
  await assert.rejects(beginPrivacySave(recovery,ticket,async()=>receipt,tenant,request(),async()=>{},()=>{completed=true;}),{status:503});assert.equal(recovery.pending,'write');assert.equal(completed,false);
 }
});
test('review receipt must match selected case, next version, state and recorded reference',async()=>{
 const operation={kind:'review' as const,caseId,body:{action:'REVIEW',expected_version:1,reason:'Synthetic review',verification_reference:'Support reference'}};
 for(const receipt of [row({id:crypto.randomUUID(),version:2,state:'IN_REVIEW',verification_reference:'Support reference'}),row({version:1,state:'IN_REVIEW',verification_reference:'Support reference'}),row({version:2,state:'REQUESTED',verification_reference:'Support reference'}),row({version:2,state:'IN_REVIEW',verification_reference:'Wrong reference'})])await assert.rejects(beginPrivacySave(new PrivacySaveRecovery(),new ClientRequests().capture(),async()=>receipt,tenant,operation,async()=>{},()=>{}),{status:503});
 let complete=false;await beginPrivacySave(new PrivacySaveRecovery(),new ClientRequests().capture(),async()=>row({version:2,state:'IN_REVIEW',verification_reference:'Support reference'}),tenant,operation,async()=>{},()=>{complete=true;});assert.equal(complete,true);
});
test('definitive validation/conflict/access failures release pending action for explicit correction',async()=>{
 for(const status of [400,401,403,404,409,422]){
  const recovery=new PrivacySaveRecovery(),operation=request();await assert.rejects(beginPrivacySave(recovery,new ClientRequests().capture(),async()=>{throw failure(status);},tenant,operation,async()=>{},()=>{}),{status});assert.equal(recovery.pending,null);assert.equal(operation.body.reason,'Synthetic privacy request');
 }
 let calls=0;await assert.rejects(beginPrivacySave(new PrivacySaveRecovery(),new ClientRequests().capture(),async()=>{calls++;},tenant,{kind:'request',body:{}},async()=>{},()=>{}),{status:422});assert.equal(calls,0);
});
test('same-frame actions and late save completions cannot publish after scope close',async()=>{
 const requests=new ClientRequests(),ticket=requests.beginAction()!,recovery=new PrivacySaveRecovery(),pending=deferred();let loads=0,completed=0;
 assert.equal(requests.beginAction(),null);const work=beginPrivacySave(recovery,ticket,async()=>pending.promise,tenant,request(),async()=>{loads++;},()=>{completed++;});requests.close();pending.resolve(row());await assert.rejects(work,{name:'AbortError'});assert.equal(loads,0);assert.equal(completed,0);assert.equal(requests.beginAction(),null);
});

test('privacy client accepts actual current SQL request, review, hold, release and withdrawal receipts',async()=>{
 const db=await localDatabase();try{
  const f=await seedPrivacyFixture(db);await identity(db,f.owner,true);let selected='';
  const read=async(path:string,options:RequestInit,scope:string,key?:string)=>{
   assert.equal(scope,f.agency.id);
   if(options.method==='POST'){const receipt=await rpc(db,'request_privacy_case',[scope,JSON.parse(String(options.body)),key,crypto.randomUUID()]);selected=receipt.id;return receipt;}
   if(options.method==='PATCH')return rpc(db,'triage_privacy_case',[scope,path.split('/').at(-1),JSON.parse(String(options.body)),key,crypto.randomUUID()]);
   if(path==='/api/v1/privacy')return {cases:(await db.query<any>("select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) rows from public.list_privacy_cases($1) c",[scope])).rows[0].rows,execution_available:false,next_cursor:null};
   return {actions:(await db.query<any>("select coalesce(jsonb_agg(jsonb_build_object('id',id,'action',action,'case_version',case_version,'reason',reason,'created_at',created_at)),'[]'::jsonb) rows from public.privacy_case_actions where tenant_id=$1 and case_id=$2",[scope,selected])).rows[0].rows,next_cursor:null};
  };
  const requests=new ClientRequests(),recovery=new PrivacySaveRecovery();let completed=0;
  const load=async(ticket:RequestTicket)=>{await loadPrivacyCases(ticket,read,f.agency.id);};
  await beginPrivacySave(recovery,requests.capture(),read,f.agency.id,{kind:'request',body:{kind:'LEAD_ERASURE',lead_id:f.lead.id,expected_version:f.lead.version,reason:'Synthetic request'}},load,()=>{completed++;});
  let expected_version=1;
  for(const action of ['REVIEW','HOLD','RELEASE_HOLD','WITHDRAW'])await beginPrivacySave(recovery,requests.capture(),read,f.agency.id,{kind:'review',caseId:selected,body:{action,expected_version:expected_version++,reason:'Synthetic review reason',...(action==='REVIEW'?{verification_reference:'Support fixture reference'}:{})}},load,()=>{completed++;});
  assert.equal(completed,5);assert.equal((await loadPrivacyCases(requests.capture(),read,f.agency.id)).cases[0].state,'WITHDRAWN');assert.equal((await loadPrivacyHistory(requests.capture(),read,f.agency.id,selected)).actions.length,4);
 }finally{await db.close();}
});
