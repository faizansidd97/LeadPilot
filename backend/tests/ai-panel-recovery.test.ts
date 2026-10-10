import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AiPanelWorkflow,createCopyOperation,validateAiHistory,validateAiReceipt,mergeAiHistory,type Draft,type DraftHistory,type AnalysisHistory} from '../../frontend/src/lib/ai-panel-workflow.ts';
import {ClientRequests} from '../../frontend/src/lib/client-workflow.ts';
import {externalDraftSchema} from '../src/domain/drafts.ts';
import {validateAnalysis} from '../src/domain/analysis.ts';
import {emptyAnalysis} from './analysis-fixtures.ts';
const tenant=crypto.randomUUID(),lead=crypto.randomUUID(),jobId=crypto.randomUUID(),draftId=crypto.randomUUID(),stamp=new Date().toISOString();
const job={id:jobId,state:'SUCCEEDED' as const,version:3,input_version:1,attempts:1,requested_at:stamp,failure_code:null,usage_state:'CONSUMED' as const,observed_tokens:40};
const draft:Draft={id:draftId,tenant_id:tenant,lead_id:lead,job_id:jobId,version:1,content_version:1,input_version:1,state:'APPROVED',freshness:'CURRENT',original_text:'Please confirm your timeline.',working_text:'Please confirm your timeline.',safety_flags:[],language:'en',tone:'PROFESSIONAL',model:'fixture',created_at:stamp,approved_at:stamp,rejection_reason:null};
const page=(row:Draft=draft):DraftHistory=>({enabled:true,outreach_allowed:true,lead:{id:lead,version:1,context_version:1},jobs:[job],drafts:[row],next_cursor:null});
const failure=(status=503)=>Object.assign(new Error('Fixture failure'),{status});
const deferred=<T>()=>{let resolve!:(value:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve};};

test('AI history validates and projects scope, job linkage, freshness, order, limits and duplicates',()=>{
 const valid=validateAiHistory('drafts',{...page(),hidden:'secret',drafts:[{...draft,internal:'secret'}]},tenant,lead) as DraftHistory;
 assert.equal('hidden' in valid,false);assert.equal('internal' in valid.drafts[0],false);
 for(const bad of [{...page(),lead:{...page().lead,id:crypto.randomUUID()}},{...page(),drafts:[{...draft,tenant_id:crypto.randomUUID()}]},{...page(),drafts:[{...draft,job_id:crypto.randomUUID()}]},{...page(),drafts:[{...draft,input_version:2}]},{...page(),drafts:[{...draft,freshness:'STALE'}]},{...page(),jobs:[job,job]},{...page(),jobs:Array(26).fill(job)},{...page(),jobs:[{...job,state:'QUEUED'}]}])assert.throws(()=>validateAiHistory('drafts',bad,tenant,lead));
});
test('AI analysis history validates real analysis schema and current analysis identity',()=>{
 const id=crypto.randomUUID(),result=validateAnalysis(emptyAnalysis(),{confirmed:{},messages:[],truncated:false,requested_at:stamp,facts_confirmed_at:null},['en']);
 const history={enabled:true,lead:{id:lead,version:1,context_version:1,current_analysis_id:id},jobs:[job],analyses:[{id,tenant_id:tenant,lead_id:lead,job_id:jobId,freshness:'CURRENT',model:'fixture',input_version:1,created_at:stamp,result}],next_cursor:null};
 assert.equal((validateAiHistory('analyses',history,tenant,lead) as AnalysisHistory).analyses[0].result.score,result.score);
 assert.throws(()=>validateAiHistory('analyses',{...history,lead:{...history.lead,current_analysis_id:null}},tenant,lead));
 assert.throws(()=>validateAiHistory('analyses',{...history,analyses:[{...history.analyses[0],result:{...result,analysis:{...result.analysis,field_evidence:[{field:'intent',message_id:'invalid'}]}}}]},tenant,lead));
});
test('AI paging rejects overlap and changed metadata instead of mixing contexts',()=>{
 const older={...page(),jobs:[{...job,id:crypto.randomUUID(),requested_at:new Date(Date.parse(stamp)-1000).toISOString()}],drafts:[]};
 assert.equal(mergeAiHistory(page(),older).jobs.length,2);
 assert.throws(()=>mergeAiHistory(page(),page()));
 assert.throws(()=>mergeAiHistory(page(),{...older,lead:{...older.lead,context_version:2}}));
 assert.throws(()=>mergeAiHistory(page(),{...older,outreach_allowed:false}));
 assert.throws(()=>validateAiHistory('drafts',{...page(),next_cursor:'malformed'},tenant,lead));
 assert.throws(()=>validateAiHistory('drafts',{...page(),next_cursor:Buffer.from(JSON.stringify({created_at:job.requested_at,id:crypto.randomUUID()})).toString('base64url')},tenant,lead));
});
test('Reopened AI scope ignores a late previous read and releases the gate before completion callbacks',async()=>{
 const first=deferred<unknown>();let reads=0,childBusy=false,childPending=false,completed=false;
 const updated={...draft,version:2};
 const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async(_path,options)=>{if(options.method)return updated;if(++reads===1)return first.promise;return reads>2?page(updated):page();},()=>{},{onStateChange:s=>{childBusy=s.busy;childPending=s.pending;}});
 const old=workflow.refresh();workflow.close();workflow.open();assert.equal(await workflow.refresh(),true);first.resolve({...page(),lead:{...page().lead,version:99}});await old;assert.equal(workflow.state.data?.lead.version,1);
 await workflow.save(`/api/v1/drafts/${draftId}/approve`,{expected_version:1,acknowledged:true},'POST',()=>{assert.equal(childBusy,false);assert.equal(childPending,false);completed=true;});assert.equal(completed,true);
});
test('Analysis cancellation recovery confirms cancelled job/version and never repeats an acknowledged cancellation',async()=>{
 let writes=0,reads=0,completed=0;
 const history=(cancelled=false):AnalysisHistory=>({enabled:true,lead:{id:lead,version:1,context_version:1,current_analysis_id:null},jobs:[{...job,state:cancelled?'CANCELLED':'QUEUED',version:cancelled?2:1}],analyses:[],next_cursor:null});
 const workflow=new AiPanelWorkflow<AnalysisHistory>('analyses',tenant,lead,async(_path,options)=>{if(options.method){writes++;return {state:'CANCELLED',usage_state:'RELEASED'};}return history(++reads>2);},()=>{});
 await workflow.refresh();assert.equal(await workflow.save(`/api/v1/ai/jobs/${jobId}/cancel`,{expected_version:1},'POST',()=>completed++),false);assert.equal(workflow.state.pending,'refresh');assert.equal(completed,0);
 assert.equal(await workflow.recover(),true);assert.equal(writes,1);assert.equal(completed,1);
});
test('AI same-frame actions share a synchronous parent gate and fence late reads after scope closure',async()=>{
 const delayed=deferred<unknown>();let reads=0,boundaryBusy=false,callbacks=0;
 const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async()=>{reads++;return delayed.promise;},()=>callbacks++,{onStateChange:s=>{boundaryBusy=s.busy;}});
 const first=workflow.refresh();assert.equal(boundaryBusy,true);assert.equal(await workflow.refresh(),false);assert.equal(reads,1);
 workflow.close();const count=callbacks;delayed.resolve(page());assert.equal(await first,false);assert.equal(callbacks,count);assert.equal(workflow.state.data,null);assert.equal(boundaryBusy,false);
 let blockedCalls=0;const blocked=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async()=>{blockedCalls++;return page();},()=>{},{canStart:()=>false});assert.equal(await blocked.refresh(),false);assert.equal(blockedCalls,0);
});
test('AI lost save acknowledgement retains exact body, version, method and key; inputs complete only after fresh history',async()=>{
 const writes:{path:string;body:string|undefined;method:string|undefined;key:string|undefined}[]=[];let first=true,complete=0;const updated={...draft,version:2,working_text:'Local edited reply',state:'EDITED' as const};
 const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async(path,options,_tenant,key)=>{if(options.method){writes.push({path,body:options.body as string,method:options.method,key});if(first){first=false;throw failure();}return updated;}return writes.length?page(updated):page();},()=>{});
 await workflow.refresh();const payload={expected_version:1,text:'Local edited reply'};
 assert.equal(await workflow.save(`/api/v1/drafts/${draftId}/edit`,payload,'PATCH',()=>complete++),false);payload.text='Changed after failure';assert.equal(workflow.state.pending,'write');assert.equal(complete,0);
 assert.equal(await workflow.save(`/api/v1/drafts/${draftId}/reject`,{expected_version:1,reason:'Other operation'}),false);assert.equal(await workflow.refresh(),false);assert.equal(writes.length,1);
 assert.equal(await workflow.recover(),true);assert.deepEqual(writes[0],writes[1]);assert.equal(JSON.parse(writes[1].body!).text,'Local edited reply');assert.equal(complete,1);assert.equal(workflow.state.pending,null);
});
test('AI known acknowledgement then read failure recovers using reads only and waits for acknowledged version',async()=>{
 let writes=0,readFailure=false,old=false,complete=0;const updated={...draft,version:2,state:'APPROVED' as const};
 const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async(_path,options)=>{if(options.method){writes++;readFailure=true;return updated;}if(readFailure){readFailure=false;throw failure();}return writes&&!old?page(updated):page();},()=>{});
 await workflow.refresh();assert.equal(await workflow.save(`/api/v1/drafts/${draftId}/approve`,{expected_version:1,acknowledged:true},'POST',()=>complete++),false);assert.equal(workflow.state.pending,'refresh');
 old=true;assert.equal(await workflow.recover(),false);assert.equal(complete,0);old=false;assert.equal(await workflow.recover(),true);assert.equal(writes,1);assert.equal(complete,1);
});
test('AI malformed or foreign acknowledgements never clear recovery or mark success',async()=>{
 let write=false;const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async(_path,options)=>options.method?(write=true,{...draft,version:2,tenant_id:crypto.randomUUID()}):page(),()=>{});
 await workflow.refresh();assert.equal(await workflow.save(`/api/v1/drafts/${draftId}/approve`,{expected_version:1,acknowledged:true}),false);assert.equal(write,true);assert.equal(workflow.state.pending,'write');assert.equal(workflow.state.ready,false);
});
test('AI definitive denial clears private snapshot and original recovery; version conflict retains local input callbacks',async()=>{
 for(const status of [401,403,404,409]){let denied=0,complete=0;const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async(_path,options)=>{if(options.method)throw failure(status);return page();},()=>{},{onAccessDenied:()=>denied++});await workflow.refresh();await workflow.save(`/api/v1/drafts/${draftId}/approve`,{expected_version:1,acknowledged:true},'POST',()=>complete++);assert.equal(workflow.state.pending,null);assert.equal(complete,0);assert.equal(denied,status===409?0:1);assert.equal(workflow.state.data===null,status!==409);}
});
test('AI acknowledged historical draft searches bounded older history before completing',async()=>{
 const olderJob={...job,id:crypto.randomUUID(),requested_at:new Date(Date.parse(stamp)-1000).toISOString()},olderDraft={...draft,id:crypto.randomUUID(),job_id:olderJob.id,version:2};let written=false,complete=0;
 const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async(path,options)=>{if(options.method){written=true;return olderDraft;}if(path.includes('?cursor='))return {...page(),jobs:[olderJob],drafts:[olderDraft],next_cursor:null};return {...page(),next_cursor:written?Buffer.from(JSON.stringify({created_at:job.requested_at,id:job.id})).toString('base64url'):null};},()=>{});
 await workflow.refresh();await workflow.save(`/api/v1/drafts/${olderDraft.id}/approve`,{expected_version:1,acknowledged:true},'POST',()=>complete++);assert.equal(complete,1);assert.equal(workflow.state.data?.drafts.length,2);
});
test('Clipboard receipt uncertainty reuses original receipt without copying twice; known receipt read failure uses reads only',async()=>{
 let copies=0,auths=0,receipts=0,reads=0,complete=0,failRead=false;const sent:{body:string;key:string|undefined}[]=[];const copied={...draft,version:2,state:'COPIED' as const};
 const workflow=new AiPanelWorkflow<DraftHistory>('drafts',tenant,lead,async(path,options,_tenant,key)=>{if(path.endsWith('/copy')){auths++;return {text:draft.working_text,expected_version:1,copy_token:crypto.randomUUID(),expires_at:new Date(Date.now()+60000).toISOString()};}if(path.endsWith('/copied')){receipts++;sent.push({body:options.body as string,key});if(receipts===1)throw failure();failRead=true;return {copied:true,draft:copied};}reads++;if(failRead){failRead=false;throw failure();}return receipts>1?page(copied):page();},()=>{});
 await workflow.refresh();await workflow.copy(draft,async()=>{copies++;},()=>complete++);assert.equal(workflow.state.pending,'write');assert.equal(copies,1);assert.equal(complete,0);
 await workflow.recover();assert.equal(workflow.state.pending,'refresh');assert.deepEqual(sent[0],sent[1]);await workflow.recover();assert.equal(complete,1);assert.equal(copies,1);assert.equal(auths,1);assert.equal(receipts,2);assert.equal(reads,3);
});
test('Clipboard permission failure does not save copied receipt; explicit retry reauthorizes with original key',async()=>{
 let copies=0,receipts=0;const keys:string[]=[];const requests=new ClientRequests(),ticket=requests.capture();
 const operation=createCopyOperation(async(path,_options,_tenant,key)=>{if(path.endsWith('/copy')){keys.push(key!);return {text:draft.working_text,expected_version:1,copy_token:crypto.randomUUID(),expires_at:new Date(Date.now()+60000).toISOString()};}receipts++;return {copied:true,draft:{...draft,version:2,state:'COPIED'}};},tenant,lead,draft,async()=>{if(++copies===1)throw Error('Clipboard denied');});
 const key=crypto.randomUUID();await assert.rejects(()=>operation(ticket,key),/Clipboard denied/);assert.equal(receipts,0);await operation(ticket,key);assert.deepEqual(keys,[key,key]);assert.equal(receipts,1);
});
test('Clipboard validation and ignored-abort authorization cannot reach clipboard or copied POST',async()=>{
 for(const bad of [{text:'Another customer reply',expected_version:1,copy_token:crypto.randomUUID(),expires_at:new Date(Date.now()+60000).toISOString()},{text:draft.working_text,expected_version:2,copy_token:crypto.randomUUID(),expires_at:stamp},{text:draft.working_text,expected_version:1,copy_token:'invalid',expires_at:stamp}]){let copies=0,receipts=0;const operation=createCopyOperation(async(path)=>{if(path.endsWith('/copied'))receipts++;return bad;},tenant,lead,draft,async()=>{copies++;});await assert.rejects(()=>operation(new ClientRequests().capture(),crypto.randomUUID()));assert.equal(copies,0);assert.equal(receipts,0);}
 const requests=new ClientRequests(),ticket=requests.capture(),delayed=deferred<unknown>();let copies=0;const operation=createCopyOperation(async()=>delayed.promise,tenant,lead,draft,async()=>{copies++;});const pending=operation(ticket,crypto.randomUUID());requests.close();delayed.resolve({text:draft.working_text,expected_version:1,copy_token:crypto.randomUUID(),expires_at:new Date(Date.now()+60000).toISOString()});await assert.rejects(()=>pending,/scope changed/);assert.equal(copies,0);
});
test('Clipboard scope closure during local copy fences receipt continuation',async()=>{
 const delayed=deferred<void>(),requests=new ClientRequests(),ticket=requests.capture();let receipts=0;
 const operation=createCopyOperation(async(path)=>{if(path.endsWith('/copied'))receipts++;return {text:draft.working_text,expected_version:1,copy_token:crypto.randomUUID(),expires_at:new Date(Date.now()+60000).toISOString()};},tenant,lead,draft,async()=>delayed.promise);
 const pending=operation(ticket,crypto.randomUUID());await new Promise(r=>setImmediate(r));requests.close();delayed.resolve();await assert.rejects(()=>pending,/scope changed/);assert.equal(receipts,0);
});
test('External log schema and nested receipt validate confirmation, past time and exact scope/body/version',()=>{
 const input=externalDraftSchema.parse({expected_version:1,expected_lead_version:1,body:' Actual reply ',occurred_at:new Date(Date.now()-10000).toISOString(),sent_confirmed:true});assert.equal(input.body,'Actual reply');
 assert.equal(externalDraftSchema.safeParse({...input,sent_confirmed:false}).success,false);assert.equal(externalDraftSchema.safeParse({...input,occurred_at:new Date(Date.now()+60000).toISOString()}).success,false);
 const receipt={draft_id:draftId,message:{lead_version:2,context_version:1,delivery_status:'USER_REPORTED',message:{id:crypto.randomUUID(),tenant_id:tenant,lead_id:lead,version:1,direction:'OUTBOUND',body:input.body,occurred_at:input.occurred_at,delivery_status:'USER_REPORTED'}}};
 assert.equal(validateAiReceipt(receipt,`/api/v1/drafts/${draftId}/external-message`,input,tenant,lead).leadVersion,2);assert.throws(()=>validateAiReceipt({...receipt,message:{...receipt.message,lead_version:1}},`/api/v1/drafts/${draftId}/external-message`,input,tenant,lead));
});
