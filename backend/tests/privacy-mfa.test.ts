import test from 'node:test';
import assert from 'node:assert/strict';
import type {RequestTicket} from '../../frontend/src/lib/client-workflow.ts';
const {ClientRequests}=await import(new URL('../../frontend/src/lib/client-workflow.ts',import.meta.url).href);
const {verifyAuthenticator,readMfaSnapshot}=await import(new URL('../../frontend/src/lib/account-recovery.ts',import.meta.url).href);
const {PrivacySaveRecovery,beginPrivacySave}=await import(new URL('../../frontend/src/lib/privacy-workflow.ts',import.meta.url).href);
const factorId=crypto.randomUUID(),tenant=crypto.randomUUID(),leadId=crypto.randomUUID(),caseId=crypto.randomUUID();
const snapshot=(recent=true,status='verified')=>({factors:[{id:factorId,status}],recent});
const deferred=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(yes=>resolve=yes);return {promise,resolve};};
const fail=(status:number,code?:string)=>Object.assign(Error('Synthetic failure'),{status,code});
const operation=()=>({kind:'request' as const,body:{kind:'LEAD_ERASURE',lead_id:leadId,expected_version:1,reason:'Synthetic request'}});
const receipt=()=>({id:caseId,tenant_id:tenant,kind:'LEAD_ERASURE',lead_id:leadId,state:'REQUESTED',reason:'Synthetic request',version:1,verification_reference:null,hold_reason:null,created_at:new Date().toISOString(),updated_at:new Date().toISOString()});

test('authenticator verification binds selected factor/code and confirms fresh verified inventory before success',async()=>{
 const ticket=new ClientRequests().capture(),calls:any[]=[];let reads=0;
 const result=await verifyAuthenticator(ticket,async(path:string,options:RequestInit)=>{calls.push({path,options});if(options.method)return {message:'Synthetic acknowledgement'};return ++reads===1?snapshot(false,'unverified'):snapshot();},factorId,'123456');
 assert.deepEqual(result,snapshot());assert.deepEqual(calls.map(c=>c.options.method??'GET'),['GET','POST','GET']);assert.ok(calls.every(c=>c.options.signal===ticket.signal&&c.path==='/api/v1/me/mfa'));
 assert.deepEqual(JSON.parse(calls[1].options.body),{action:'verify',factor_id:factorId,code:'123456'});
});
test('invalid code, missing factor and unavailable inventory cannot make verification POST',async()=>{
 for(const [id,code,value] of [[factorId,'abc123',snapshot()],[factorId,'12345',snapshot()],['invalid','123456',snapshot()],[factorId,'123456',{factors:[],recent:false}],[factorId,'123456',null]]){
  let posts=0;await assert.rejects(verifyAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>{if(options.method)posts++;return value;},String(id),String(code)));assert.equal(posts,0);
 }
});
test('verification rejects malformed acknowledgement and non-recent/missing/unverified fresh factors',async()=>{
 for(const final of [snapshot(false),snapshot(true,'unverified'),{factors:[],recent:true},{factors:[{id:crypto.randomUUID(),status:'verified'}],recent:true}]){
  let reads=0;await assert.rejects(verifyAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>options.method?{message:'Accepted'}:++reads===1?snapshot(false):final,factorId,'123456'),(e:any)=>e.status===503);
 }
 for(const acknowledgement of [null,{}, {message:''},{message:'x'.repeat(501)}])await assert.rejects(verifyAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>options.method?acknowledgement:snapshot(false),factorId,'123456'),(e:any)=>e.status===503&&!e.message.includes('x'.repeat(50)));
});
test('late preflight or final verification cannot publish or act after the inline scope closes',async()=>{
 for(const phase of ['preflight','final']){
  const requests=new ClientRequests(),ticket=requests.capture(),pending=deferred(),entered=deferred();let reads=0,posts=0,published=false;
  const work=verifyAuthenticator(ticket,async(_path:string,options:RequestInit)=>{if(options.method){posts++;return {message:'Accepted'};}reads++;if(phase==='preflight'||reads===2){entered.resolve(true);return pending.promise;}return snapshot(false);},factorId,'123456').then(()=>{published=true;});
  await entered.promise;requests.close();requests.replace();pending.resolve(snapshot());await assert.rejects(work,{name:'AbortError'});assert.equal(published,false);assert.equal(posts,phase==='preflight'?0:1);
 }
});
test('lost verification acknowledgement reconciles by explicit factor refresh without automatic second POST',async()=>{
 const ticket=new ClientRequests().capture();let posts=0;
 const read=async(_path:string,options:RequestInit)=>{if(options.method){posts++;throw fail(503);}return snapshot();};
 await assert.rejects(verifyAuthenticator(ticket,read,factorId,'123456'),{status:503});assert.equal(posts,1);
 assert.equal((await readMfaSnapshot(ticket,read)).recent,true);assert.equal(posts,1);
});
test('privacy save keeps original key/payload through uncertain write and recent MFA, then requires explicit recovery',async()=>{
 const requests=new ClientRequests(),recovery=new PrivacySaveRecovery(),input=operation(),calls:any[]=[];let writes=0,complete=0;
 const read=async(_path:string,options:RequestInit,_tenant:string,key?:string)=>{calls.push({key,body:options.body});writes++;if(writes===1)throw fail(503);if(writes===2)throw fail(403,'RECENT_MFA_REQUIRED');return receipt();};
 await assert.rejects(beginPrivacySave(recovery,requests.capture(),read,tenant,input,async()=>{},()=>{complete++;}),{status:503});
 await assert.rejects(recovery.recover(requests.capture()),{status:403});assert.equal(recovery.pending,'write');input.body.reason='Edited caller text';
 await verifyAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>options.method?{message:'Accepted'}:snapshot(),factorId,'123456');
 assert.equal(writes,2);assert.equal(complete,0);assert.equal(recovery.pending,'write');
 await recovery.recover(requests.capture());assert.equal(complete,1);assert.equal(recovery.pending,null);assert.ok(calls.every(c=>c.key===calls[0].key&&c.body===calls[0].body));
});
test('only exact recent-MFA write denial is retained; revoked access still clears pending privacy recovery',async()=>{
 for(const error of [fail(401,'RECENT_MFA_REQUIRED'),fail(403,'ROLE_REQUIRED'),fail(403),fail(404)]){
  const recovery=new PrivacySaveRecovery(),ticket=new ClientRequests().capture();await assert.rejects(beginPrivacySave(recovery,ticket,async()=>{throw error;},tenant,operation(),async()=>{},()=>{}));assert.equal(recovery.pending,null);
 }
 const recovery=new PrivacySaveRecovery(),ticket=new ClientRequests().capture();await assert.rejects(beginPrivacySave(recovery,ticket,async()=>{throw fail(403,'RECENT_MFA_REQUIRED');},tenant,operation(),async()=>{},()=>{}));assert.equal(recovery.pending,'write');recovery.clear();assert.equal(await recovery.recover(ticket),'idle');
});
test('closed or duplicate authenticator action cannot dispatch through current request tickets',async()=>{
 const requests=new ClientRequests(),ticket=requests.beginAction()!;assert.equal(requests.beginAction(),null);requests.close();let calls=0;
 await assert.rejects(verifyAuthenticator(ticket as RequestTicket,async()=>{calls++;return snapshot();},factorId,'123456'),{name:'AbortError'});assert.equal(calls,0);assert.equal(requests.beginAction(),null);
});
