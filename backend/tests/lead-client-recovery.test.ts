import test from 'node:test';
import assert from 'node:assert/strict';
const {ClientRequests}=await import(new URL('../../frontend/src/lib/client-workflow.ts',import.meta.url).href);
const {LeadSaveRecovery,loadLeadSnapshot,verifyLeadReceipt}=await import(new URL('../../frontend/src/lib/lead-workflow.ts',import.meta.url).href);
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};};
const failure=(status=503)=>Object.assign(Error('Synthetic failure'),{status});
function fixture(){return [
 {id:'lead-a',tenant_id:'agency-a',full_name:'Synthetic lead',version:2,status:'NEW',locations:[]},
 {messages:[],pagination:{next_cursor:null}},
 {follow_ups:[],pagination:{next_cursor:null}},
 {role:'OWNER',lead_version:2},
 {events:[],pagination:{next_cursor:null}},
 {members:[{id:'member-a',role:'OWNER',label:'Synthetic member'}]},
];}
function reader(values:any[],calls:any[]=[]){let index=0;return async(path:string,options:RequestInit,tenant:string)=>{calls.push({path,options,tenant});return values[index++];};}

test('lead snapshot publishes only all six scoped reads with one abort signal',async()=>{
 const calls:any[]=[],ticket=new ClientRequests().capture();
 const result=await loadLeadSnapshot(ticket,reader(fixture(),calls),'agency-a','lead-a','OWNER');
 assert.equal(result.row.id,'lead-a');assert.equal(calls.length,6);
 assert.ok(calls.every(call=>call.tenant==='agency-a'&&call.options.signal===ticket.signal));
});
test('failed or ignored-abort late snapshot cannot publish a partial or old lead',async()=>{
 const requests=new ClientRequests(),ticket=requests.capture(),response=deferred<any>();let visible='current';
 const work=loadLeadSnapshot(ticket,async()=>response.promise,'agency-a','lead-a','OWNER').then(()=>{visible='old';});
 requests.replace();response.resolve({});await assert.rejects(work,{name:'AbortError'});assert.equal(visible,'current');
 let count=0;await assert.rejects(loadLeadSnapshot(requests.capture(),async()=>{if(++count===2)throw failure();return fixture()[count-1];},'agency-a','lead-a','OWNER'));
});
test('malformed, cross-lead/tenant, duplicate rows and mismatched versions fail before publication',async()=>{
 const mutations=[
  (f:any[])=>{f[0].tenant_id='foreign';},(f:any[])=>{f[0].id='foreign';},
  (f:any[])=>{f[3].lead_version=3;},(f:any[])=>{f[2].pagination={};},
  (f:any[])=>{f[1].messages=[{id:'message',lead_id:'foreign',tenant_id:'agency-a'}];},
  (f:any[])=>{f[2].follow_ups=[{id:'task',lead_id:'lead-a',tenant_id:'foreign'}];},
  (f:any[])=>{f[4].events=[{id:'event',event_type:'LEAD_CREATED',details:{}},{id:'event',event_type:'LEAD_CREATED',details:{}}];},
  (f:any[])=>{f[5].members=[{id:'member',role:'INVALID',label:'Synthetic'}];},
 ];
 for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(loadLeadSnapshot(new ClientRequests().capture(),reader(f),'agency-a','lead-a','OWNER'),{status:503});}
});
test('fresh role mismatch is an access reset rather than retained manager controls',async()=>{
 const f=fixture();f[3].role='AGENT';await assert.rejects(loadLeadSnapshot(new ClientRequests().capture(),reader(f),'agency-a','lead-a','OWNER'),{status:403});
});
test('lost acknowledgement recovers the exact original write once and clears fields only after current refresh',async()=>{
 const recovery=new LeadSaveRecovery(),requests=new ClientRequests(),keys:string[]=[],receipts=new Set<string>();let writes=0,completed=0,first=true;
 const input={expected_lead_version:2,title:'Synthetic task'};const bodies:string[]=[];
 await assert.rejects(recovery.start(requests.capture(),{replayable:true,write:async(_ticket:any,key:string)=>{keys.push(key);bodies.push(JSON.stringify(input));if(!receipts.has(key)){receipts.add(key);writes++;}if(first){first=false;throw failure();}},load:async()=>{},complete:()=>{completed++;}}));
 assert.equal(recovery.pending,'write');assert.equal(completed,0);
 // Changed authoritative versions from a separate reload never replace the original write closure/body.
 await recovery.recover(requests.capture());assert.equal(keys[0],keys[1]);assert.equal(bodies[0],bodies[1]);assert.equal(writes,1);assert.equal(completed,1);assert.equal(recovery.pending,null);
 assert.equal(await recovery.recover(requests.capture()),'idle');assert.equal(completed,1);
});
test('acknowledged save with failed post-save read recovers by reading without another write',async()=>{
 const recovery=new LeadSaveRecovery(),requests=new ClientRequests();let writes=0,reads=0,completed=0;
 await assert.rejects(recovery.start(requests.capture(),{replayable:true,write:async()=>{writes++;},load:async()=>{if(++reads===1)throw failure();},complete:()=>{completed++;}}));
 assert.equal(recovery.pending,'refresh');assert.equal(completed,0);
 await recovery.recover(requests.capture());assert.equal(writes,1);assert.equal(reads,2);assert.equal(completed,1);
});
test('uncertain version-only contact save requires read/inspection and never repeats PATCH',async()=>{
 const recovery=new LeadSaveRecovery(),requests=new ClientRequests();let writes=0,reads=0,completed=0;
 await assert.rejects(recovery.start(requests.capture(),{replayable:false,write:async()=>{writes++;throw failure();},load:async()=>{reads++;},complete:()=>{completed++;}}));
 assert.equal(recovery.pending,'inspect');assert.equal(await recovery.recover(requests.capture()),'review');
 assert.equal(writes,1);assert.equal(reads,1);assert.equal(completed,0);assert.equal(recovery.pending,null);
});
test('definitive denied/conflict/input response cannot strand a pending write',async()=>{
 for(const status of [400,401,403,404,409,422]){
  const recovery=new LeadSaveRecovery();let completed=0;
  await assert.rejects(recovery.start(new ClientRequests().capture(),{replayable:true,write:async()=>{throw failure(status);},load:async()=>{},complete:()=>{completed++;}}));
  assert.equal(recovery.pending,null);assert.equal(completed,0);
 }
});
test('read access denial clears an acknowledged pending save without claiming completion',async()=>{
 const recovery=new LeadSaveRecovery();let completed=0;
 await assert.rejects(recovery.start(new ClientRequests().capture(),{replayable:true,write:async()=>{},load:async()=>{throw failure(403);},complete:()=>{completed++;}}));
 assert.equal(recovery.pending,null);assert.equal(completed,0);
});
test('new save cannot replace an unresolved operation; double action is rejected synchronously',async()=>{
 const recovery=new LeadSaveRecovery(),requests=new ClientRequests(),ticket=requests.beginAction();assert.ok(ticket);assert.equal(requests.beginAction(),null);
 const work={replayable:true,write:async()=>{throw failure();},load:async()=>{},complete:()=>{}};
 await assert.rejects(recovery.start(ticket,work));requests.finishAction(ticket);
 const next=requests.beginAction();assert.ok(next);await assert.rejects(recovery.start(next,work));assert.equal(recovery.pending,'write');
});
test('unmount during write or follow-up read cannot reset a retained form or mark saved',async()=>{
 for(const stage of ['write','read']){
  const recovery=new LeadSaveRecovery(),requests=new ClientRequests(),pending=deferred<void>();let completed=0;
  const work=recovery.start(requests.capture(),{replayable:true,write:async()=>{if(stage==='write')await pending.promise;},load:async()=>{if(stage==='read')await pending.promise;},complete:()=>{completed++;}});
  await Promise.resolve();await Promise.resolve();requests.close();recovery.clear();requests.replace();pending.resolve();await assert.rejects(work,{name:'AbortError'});assert.equal(completed,0);assert.equal(recovery.pending,null);
 }
});
test('write acknowledgements bind saved resource identity and reject malformed success',()=>{
 verifyLeadReceipt({follow_up:{id:'task-a',lead_id:'lead-a',version:1},lead_version:3},'lead-a','/api/v1/follow-ups','POST');
 verifyLeadReceipt({id:'lead-a',version:3},'lead-a','/api/v1/leads/lead-a','PATCH');
 for(const value of [{},null,{id:'foreign',version:3},{follow_up:{id:'task-b',lead_id:'lead-a',version:2},lead_version:3},{message:{id:'message',lead_id:'foreign',version:1},lead_version:3}])assert.throws(()=>verifyLeadReceipt(value,'lead-a','/api/v1/follow-ups/task-a/complete','POST'));
});
