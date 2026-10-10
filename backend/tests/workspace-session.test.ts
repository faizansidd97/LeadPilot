import test from 'node:test';
import assert from 'node:assert/strict';
const {ClientRequests,MutationRetry}=await import(new URL('../../frontend/src/lib/client-workflow.ts',import.meta.url).href);
const {loadWorkspaceSession,completeSessionSignOut,sessionFailurePhase,SessionReadError}=await import(new URL('../../frontend/src/lib/workspace-session.ts',import.meta.url).href);
const member=(tenant='agency-a',role='OWNER')=>({id:'member-'+tenant,tenant_id:tenant,role,agencies:{name:tenant,timezone:'Asia/Dubai'}});
const identity=(memberships:any[]=[],user='user-a')=>({user:{id:user},memberships});
const lead={id:'lead-a',full_name:'Synthetic fixture',locations:['Dubai']};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};};
test('bootstrap opens only one current membership and does not eagerly read other agency leads',async()=>{
 for(const memberships of [[],[member(),member('agency-b')],[member()]]){
  const calls:any[]=[];const result=await loadWorkspaceSession(new ClientRequests().capture(),async(path:string,options:RequestInit,tenant?:string)=>{calls.push({path,options,tenant});return tenant?{leads:[lead]}:identity(memberships);});
  assert.equal(result.userId,'user-a');assert.equal(result.active?.tenant_id??null,memberships.length===1?'agency-a':null);assert.equal(calls.length,memberships.length===1?2:1);assert.equal(calls[0].tenant,undefined);assert.ok(calls[0].options.signal);
 }
});
test('agency selection uses fresh role and agency metadata',async()=>{
 const result=await loadWorkspaceSession(new ClientRequests().capture(),async(_path:string,_options:any,tenant?:string)=>{
  if(tenant){assert.equal(tenant,'agency-b');return {leads:[lead]};}
  return identity([member(),{...member('agency-b','AGENT'),agencies:{name:'Updated agency',timezone:'Asia/Karachi'}}]);
 },{tenant:'agency-b'});
 assert.equal(result.active.role,'AGENT');assert.equal(result.active.agencies.name,'Updated agency');
});
test('revoked selection cannot read leads or silently open another agency',async()=>{
 let calls=0;await assert.rejects(loadWorkspaceSession(new ClientRequests().capture(),async()=>{calls++;return identity([member('agency-b')]);},{tenant:'agency-a'}),(e:any)=>e.status===403);assert.equal(calls,1);
});
test('refreshing the agency list can retain explicit choice even for a single membership',async()=>{
 let calls=0;const result=await loadWorkspaceSession(new ClientRequests().capture(),async()=>{calls++;return identity([member()]);},{choose:true});assert.equal(calls,1);assert.equal(result.active,null);
});
test('outages, rate limits and agency denial are recovery; only a 401 opens login',()=>{
 for(const status of [403,429,500,503])assert.equal(sessionFailurePhase(new SessionReadError('fixture',status)),'recovery');assert.equal(sessionFailurePhase(new SessionReadError('fixture',401)),'login');assert.equal(sessionFailurePhase(Error('network')),'recovery');assert.equal(sessionFailurePhase(null),'recovery');
});
test('late membership response cannot fetch leads or publish after unmount/effect replay',async()=>{
 const requests=new ClientRequests(),ticket=requests.capture(),pending=deferred<any>();let calls=0,published=false;
 const work=loadWorkspaceSession(ticket,async()=>{calls++;return pending.promise;}).then(()=>{published=true;});requests.close();requests.replace();pending.resolve(identity([member()]));await assert.rejects(work,{name:'AbortError'});assert.equal(calls,1);assert.equal(published,false);
});
test('late lead response cannot publish an old agency when transport ignores abort',async()=>{
 const requests=new ClientRequests(),ticket=requests.capture(),pending=deferred<any>(),entered=deferred<void>();let published=false;
 const work=loadWorkspaceSession(ticket,async(_path:string,_options:any,tenant?:string)=>{if(!tenant)return identity([member()]);entered.resolve();return pending.promise;}).then(()=>{published=true;});await entered.promise;requests.replace();pending.resolve({leads:[lead]});await assert.rejects(work,{name:'AbortError'});assert.equal(published,false);
});
test('malformed membership or lead data cannot return a partially opened workspace',async()=>{
 for(const data of [null,{},identity([null]),identity([member('a','INVALID')]),identity([member(),member()]),identity([{...member(),agencies:null}]),{user:{},memberships:[]}])await assert.rejects(loadWorkspaceSession(new ClientRequests().capture(),async()=>data),(e:any)=>e.status===503);
 for(const leads of [null,{},[null],[{}],[{...lead,locations:'PRIVATE_BAD'}]])await assert.rejects(loadWorkspaceSession(new ClientRequests().capture(),async(_path:string,_options:any,tenant?:string)=>tenant?{leads}:identity([member()])),(e:any)=>e.status===503&&!e.message.includes('PRIVATE_BAD'));
});
test('account changes after creation fail before lead reads or acknowledging an old-account workflow',async()=>{
 let calls=0;await assert.rejects(loadWorkspaceSession(new ClientRequests().capture(),async()=>{calls++;return identity([member()],'other-user');},{expectedUser:'user-a'}),(e:any)=>e.status===401);assert.equal(calls,1);
});
test('creation retry retains one committed receipt through failed bootstrap',async()=>{
 const requests=new ClientRequests(),retry=new MutationRetry(),keys:string[]=[],receipts=new Set<string>();let saved=0,unavailable=true,visible:any;
 const write=async(key:string)=>{keys.push(key);if(!receipts.has(key)){receipts.add(key);saved++;}return {id:'agency-a'};};
 const after=async()=>{visible=await loadWorkspaceSession(requests.capture(),async(_path:string,_options:any,tenant?:string)=>{if(unavailable)throw new SessionReadError('Unavailable');return tenant?{leads:[]}:identity([member()]);},{expectedUser:'user-a'});};
 await assert.rejects(retry.run('user-a','/api/v1/agencies','POST',{name:'Fixture'},requests.capture(),write,after));assert.equal(visible,undefined);unavailable=false;await retry.run('user-a','/api/v1/agencies','POST',{name:'Fixture'},requests.capture(),write,after);assert.equal(saved,1);assert.equal(keys[0],keys[1]);assert.equal((visible as any).active.tenant_id,'agency-a');
});
test('identical agency creation payload uses a different key for another account',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),keys:string[]=[];
 for(const user of ['user-a','user-b'])await assert.rejects(retry.run(user,'/api/v1/agencies','POST',{name:'Fixture'},requests.capture(),async(key:string)=>{keys.push(key);throw Error('Lost acknowledgement');},async()=>{}));assert.notEqual(keys[0],keys[1]);
});
test('sign-out requires explicit confirmation and a cancellable POST',async()=>{
 const ticket=new ClientRequests().capture();await completeSessionSignOut(ticket,async(path:string,options:RequestInit)=>{assert.equal(path,'/api/v1/auth/sign-out');assert.equal(options.method,'POST');assert.equal(options.signal,ticket.signal);return {signed_out:true};});
 for(const result of [null,{},false,{signed_out:false},{signed_out:'true'}])await assert.rejects(completeSessionSignOut(ticket,async()=>result),(e:any)=>e.status===503);
 await assert.rejects(completeSessionSignOut(ticket,async()=>{throw new SessionReadError('Unavailable');}));
});
test('old sign-out acknowledgement cannot send a newer session to login',async()=>{
 const requests=new ClientRequests(),pending=deferred<any>();let login=false;
 const work=completeSessionSignOut(requests.capture(),async()=>pending.promise).then(()=>{login=true;});requests.close();requests.replace();pending.resolve({signed_out:true});await assert.rejects(work,{name:'AbortError'});assert.equal(login,false);
});

