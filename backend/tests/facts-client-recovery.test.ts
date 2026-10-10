import test from 'node:test';
import assert from 'node:assert/strict';
import {localDatabase,seedPrivacyFixture,identity,rpc} from './helpers/local-db.ts';
import type {RequestTicket} from '../../frontend/src/lib/client-workflow.ts';
const {ClientRequests}=await import(new URL('../../frontend/src/lib/client-workflow.ts',import.meta.url).href);
const {LeadSaveRecovery}=await import(new URL('../../frontend/src/lib/lead-workflow.ts',import.meta.url).href);
const {loadFactsLead,loadDuplicatePage,beginFactsSave,verifyFactsLead}=await import(new URL('../../frontend/src/lib/facts-workflow.ts',import.meta.url).href);
const tenant=crypto.randomUUID(),id=crypto.randomUUID();
const failure=(status=503)=>Object.assign(Error('Synthetic failure'),{status});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return {promise,resolve};};
const row=(extra:any={})=>({id,tenant_id:tenant,version:2,full_name:'Synthetic lead',status:'NEW',source:'MANUAL',duplicate_review:true,archived_at:null,confirmed_intent:null,budget_period:'UNKNOWN',locations:[],property_type:null,bedrooms:null,purchase_timeline:null,source_reference:null,notes:'',...extra});
const candidate=(key=crypto.randomUUID())=>({id:key,full_name:'Synthetic match',email:'fixture@example.test',phone:null,status:'NEW',archived_at:null});
const page=(candidates:any[]=[])=>({restricted:false,review_required:true,candidates,next_cursor:null});
const operation=(kind='facts')=>({kind,input:kind==='facts'?{expected_version:1,locations:['Dubai Marina'],notes:'Synthetic notes'}:{expected_version:1,reason:'Synthetic separate lead'}});

test('facts read binds lead/tenant and abort signal, projecting only workspace properties',async()=>{
 const calls:any[]=[],ticket=new ClientRequests().capture();
 const result=await loadFactsLead(ticket,async(...args:any[])=>{calls.push(args);return row({private_token:'Never publish'});},tenant,id);
 assert.equal(calls[0][0],'/api/v1/leads/'+id);assert.equal(calls[0][1].signal,ticket.signal);assert.equal(calls[0][2],tenant);
 assert.equal(result.id,id);assert.equal(Object.hasOwn(result,'private_token'),false);
});

test('facts reads reject foreign, malformed, invalid facts and older-than-receipt versions',async()=>{
 for(const data of [row({id:crypto.randomUUID()}),row({tenant_id:crypto.randomUUID()}),row({version:0}),row({notes:null}),row({locations:[123]}),row({bedrooms:51}),row({source:'UNTRUSTED'}),row({archived_at:'invalid'}),row({duplicate_review:'yes'}),row({email:{private:'value'}}),row({budget_min:-1}),row({reported_facts:[]}),row({do_not_contact:'yes'}),row({current_analysis:'invalid'})])
  await assert.rejects(loadFactsLead(new ClientRequests().capture(),async()=>data,tenant,id),{status:503});
 assert.throws(()=>verifyFactsLead(row(),tenant,id,3),{status:503});
});

test('late facts or matching contacts cannot publish after scope replacement despite ignored abort',async()=>{
 for(const kind of ['facts','matches']){
  const requests=new ClientRequests(),pending=deferred();let published=false;
  const ticket=requests.capture(),work=(kind==='facts'?loadFactsLead(ticket,async()=>pending.promise,tenant,id):loadDuplicatePage(ticket,async()=>pending.promise,tenant,id,'OWNER')).then(()=>{published=true;});
  requests.close();requests.replace();pending.resolve(kind==='facts'?row():page([candidate()]));await assert.rejects(work,{name:'AbortError'});assert.equal(published,false);
 }
});

test('duplicate pages minimize fields and deny agent/revoked manager inventory',async()=>{
 const ticket=new ClientRequests().capture(),match={...candidate(),private_email:'Never publish'},calls:any[]=[];
 const result=await loadDuplicatePage(ticket,async(...args:any[])=>{calls.push(args);return page([match]);},tenant,id,'ADMIN');
 assert.equal(calls[0][2],tenant);assert.equal(calls[0][1].signal,ticket.signal);assert.equal(Object.hasOwn(result.candidates[0],'private_email'),false);
 let reads=0;await assert.rejects(loadDuplicatePage(ticket,async()=>{reads++;return page();},tenant,id,'AGENT'),{status:403});assert.equal(reads,0);
 await assert.rejects(loadDuplicatePage(ticket,async()=>({...page([match]),restricted:true}),tenant,id,'OWNER'),{status:403});
});

test('malformed duplicate pages are unavailable rather than an empty matching result',async()=>{
 const match=candidate();
 for(const data of [null,{...page(),next_cursor:undefined},{...page(),review_required:'yes'},{...page(),restricted:undefined},page([candidate(id)]),page([match,match]),page([candidate('invalid')]),page([{...match,status:'UNTRUSTED'}]),page([{...match,email:123}]),page([{...match,archived_at:'invalid'}])])
  await assert.rejects(loadDuplicatePage(new ClientRequests().capture(),async()=>data,tenant,id,'OWNER'),{status:503});
 assert.deepEqual((await loadDuplicatePage(new ClientRequests().capture(),async()=>page(),tenant,id,'OWNER')).candidates,[]);
});

test('candidate cursor requires bounded ordered pages after the previous last match',async()=>{
 const matches=Array.from({length:25},()=>candidate()).sort((a,b)=>a.id.localeCompare(b.id));
 const data={...page(matches),next_cursor:matches.at(-1)!.id};
 assert.equal((await loadDuplicatePage(new ClientRequests().capture(),async()=>data,tenant,id,'OWNER')).candidates.length,25);
 for(const bad of [{...data,next_cursor:matches[0].id},{...data,candidates:matches.slice(0,24)},page([...matches].reverse()),page([...matches,candidate()])])
  await assert.rejects(loadDuplicatePage(new ClientRequests().capture(),async()=>bad,tenant,id,'OWNER'),{status:503});
 await assert.rejects(loadDuplicatePage(new ClientRequests().capture(),async()=>page([matches[0]]),tenant,id,'OWNER',matches[0].id),{status:503});
 let path='';await loadDuplicatePage(new ClientRequests().capture(),async(url:string)=>{path=url;return page();},tenant,id,'OWNER',matches[0].id);assert.equal(path,'/api/v1/leads/'+id+'/duplicates?cursor='+matches[0].id);
});

test('lost facts acknowledgement preserves the original serialized fields/version/key on recovery',async()=>{
 const requests=new ClientRequests(),recovery=new LeadSaveRecovery(),op=operation(),calls:any[]=[],receipts=new Set<string>();let writes=0,first=true,published=0,completed=0;
 const read=async(path:string,options:RequestInit,_scope:string,key?:string)=>{
  if(options.method){calls.push({path,body:options.body,key});if(!receipts.has(key!)){receipts.add(key!);writes++;}if(first){first=false;throw failure();}}
  return row();
 };
 await assert.rejects(beginFactsSave(recovery,requests.capture(),read,tenant,id,op,()=>{published++;},()=>{completed++;}));
 op.input.locations=['JVC'];op.input.expected_version=77;
 await recovery.recover(requests.capture());assert.equal(calls[0].key,calls[1].key);assert.equal(calls[0].body,calls[1].body);
 assert.equal(JSON.parse(calls[1].body).expected_version,1);assert.deepEqual(JSON.parse(calls[1].body).locations,['Dubai Marina']);assert.equal(writes,1);assert.equal(published,1);assert.equal(completed,1);
});

test('confirmed duplicate save with failed refresh retries reads only and retains completion until success',async()=>{
 const requests=new ClientRequests(),recovery=new LeadSaveRecovery();let writes=0,reads=0,completed=0;
 const read=async(_path:string,options:RequestInit)=>{if(options.method){writes++;return row({duplicate_review:false});}if(++reads===1)throw failure();return row({duplicate_review:false});};
 await assert.rejects(beginFactsSave(recovery,requests.capture(),read,tenant,id,operation('duplicates'),()=>{},()=>{completed++;}));
 assert.equal(recovery.pending,'refresh');assert.equal(completed,0);await recovery.recover(requests.capture());assert.equal(writes,1);assert.equal(reads,2);assert.equal(completed,1);
});

test('wrong receipt scope/version or unresolved duplicate state cannot acknowledge a save',async()=>{
 for(const data of [row({tenant_id:crypto.randomUUID()}),row({version:1}),row({version:3}),row()]){
  const recovery=new LeadSaveRecovery();let loads=0,completed=0;
  await assert.rejects(beginFactsSave(recovery,new ClientRequests().capture(),async(_path:string,options:RequestInit)=>{if(!options.method)loads++;return data;},tenant,id,operation('duplicates'),()=>{},()=>{completed++;}),{status:503});
  assert.equal(recovery.pending,'write');assert.equal(loads,0);assert.equal(completed,0);
 }
});

test('validation/conflict/access denials release recovery; synchronous duplicate actions cannot overlap',async()=>{
 const requests=new ClientRequests(),ticket=requests.beginAction()!;assert.equal(requests.beginAction(),null);requests.finishAction(ticket);
 for(const status of [400,401,403,404,409,422]){
  const recovery=new LeadSaveRecovery();await assert.rejects(beginFactsSave(recovery,requests.capture(),async()=>{throw failure(status);},tenant,id,operation(),()=>{},()=>{}),{status});assert.equal(recovery.pending,null);
 }
 let calls=0;await assert.rejects(beginFactsSave(new LeadSaveRecovery(),requests.capture(),async()=>{calls++;},tenant,id,{kind:'facts',input:{expected_version:1}},()=>{},()=>{}),{status:422});assert.equal(calls,0);
});

test('scope close during original save or post-save read cannot publish/reset mounted inputs',async()=>{
 for(const stage of ['write','read']){
  const requests=new ClientRequests(),recovery=new LeadSaveRecovery(),pending=deferred();let published=0,completed=0;
  const work=beginFactsSave(recovery,requests.capture(),async(_path:string,options:RequestInit)=>{if((!!options.method)===(stage==='write'))await pending.promise;return row();},tenant,id,operation(),()=>{published++;},()=>{completed++;});
  await Promise.resolve();await Promise.resolve();requests.close();recovery.clear();pending.resolve(row());await assert.rejects(work,{name:'AbortError'});assert.equal(published,0);assert.equal(completed,0);
 }
});

test('facts and duplicate client recovery accept actual SQL receipts/current reads and scoped candidates',async()=>{
 const db=await localDatabase();try{
  const f=await seedPrivacyFixture(db);await db.exec('reset role');
  await db.query("update public.leads set duplicate_review=true where id=$1",[f.lead.id]);
  const match=(await db.query<any>("insert into public.leads(tenant_id,full_name,email,source,created_by) values($1,'Synthetic match','synthetic@example.test','MANUAL',$2) returning *",[f.agency.id,f.owner])).rows[0];
  await identity(db,f.owner);const read=async(path:string,options:RequestInit,scope:string,key?:string)=>{
   assert.equal(scope,f.agency.id);
   if(options.method)return rpc(db,path.endsWith('/facts')?'update_lead_facts':'resolve_duplicate',[scope,f.lead.id,JSON.parse(String(options.body)),key,crypto.randomUUID()]);
   if(path.includes('/duplicates')){const result=await rpc(db,'duplicate_candidates',[scope,f.lead.id,26,null]);return {...result,next_cursor:null};}
   // Match PostgREST JSON timestamps rather than PGlite's raw Date objects.
   return (await db.query<{row:any}>('select to_jsonb(l) row from public.leads l where tenant_id=$1 and id=$2',[scope,f.lead.id])).rows[0].row;
  };
  const requests=new ClientRequests(),recovery=new LeadSaveRecovery();let latest:Record<string,unknown>={},completed=0;
  await beginFactsSave(recovery,requests.capture(),read,f.agency.id,f.lead.id,{kind:'facts',input:{expected_version:f.lead.version,locations:['JVC'],notes:'Synthetic facts'}},(data:Record<string,unknown>)=>{latest=data;},()=>{completed++;});
  assert.deepEqual(latest.locations,['JVC']);assert.equal(latest.version,2);
  const matches=await loadDuplicatePage(requests.capture(),read,f.agency.id,f.lead.id,'OWNER');assert.equal(matches.candidates[0].id,match.id);assert.equal(matches.candidates.length,1);
  await beginFactsSave(recovery,requests.capture(),read,f.agency.id,f.lead.id,{kind:'duplicates',input:{expected_version:2,reason:'Synthetic separate records'}},(data:Record<string,unknown>)=>{latest=data;},()=>{completed++;});
  assert.equal(latest.duplicate_review,false);assert.equal(latest.version,3);assert.equal(completed,2);
  await identity(db,f.other);await assert.rejects(read('/api/v1/leads/'+f.lead.id+'/facts',{method:'PATCH',body:JSON.stringify({expected_version:3,notes:'Denied fixture'})},f.agency.id,crypto.randomUUID()),/MEMBERSHIP_REQUIRED/);
 }finally{await db.close();}
});
