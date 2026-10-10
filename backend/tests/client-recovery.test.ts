import test from 'node:test';
import assert from 'node:assert/strict';
// Import the actual client helpers at runtime without pulling JSX/path aliases into backend tsc.
const {ClientRequests,MutationRetry}=await import(new URL('../../frontend/src/lib/client-workflow.ts',import.meta.url).href);
const {requestApi,ApiClientError}=await import(new URL('../../frontend/src/lib/api-client.ts',import.meta.url).href);
const deferred=<T>()=>{let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function withFetch(run:(calls:{path:string;init?:RequestInit}[])=>Promise<void>,send:(input:any,init?:RequestInit)=>Promise<Response>){
 const original=globalThis.fetch,calls:{path:string;init?:RequestInit}[]=[];
 globalThis.fetch=async(input,init)=>{calls.push({path:String(input),init});return send(input,init);};
 try{await run(calls);}finally{globalThis.fetch=original;}
}

test('effect replay cannot reactivate an old deferred response, even if transport ignores abort',async()=>{
 const requests=new ClientRequests(),old=requests.replace(),response=deferred<string>();let visible='new';
 const oldWork=response.promise.then(value=>{old.assertCurrent();visible=value;});
 requests.close();const current=requests.replace();assert.equal(old.signal.aborted,true);assert.equal(current.isCurrent(),true);
 response.resolve('OLD_PRIVATE_SECRET');await assert.rejects(oldWork,{name:'AbortError'});assert.equal(visible,'new');
});
test('same-frame actions are locked and stale cleanup cannot unlock a newer action',()=>{
 const requests=new ClientRequests(),old=requests.beginAction();assert.ok(old);assert.equal(requests.beginAction(),null);
 requests.close();requests.replace();const next=requests.beginAction();assert.ok(next);requests.finishAction(old);assert.equal(requests.beginAction(),null);
 requests.finishAction(next);assert.ok(requests.beginAction());
});
test('unmount cancels current signals and rejects new work until a new effect scope is created',()=>{
 const requests=new ClientRequests(),ticket=requests.capture();requests.close();assert.equal(ticket.signal.aborted,true);assert.throws(()=>ticket.assertCurrent(),{name:'AbortError'});
 assert.throws(()=>requests.capture().assertCurrent(),{name:'AbortError'});assert.ok(requests.replace().isCurrent());
});
test('late queued actions cannot reopen an unmounted request scope',()=>{
 const requests=new ClientRequests();requests.close();assert.equal(requests.beginAction(),null);assert.equal(requests.capture().isCurrent(),false);
});
test('lost mutation acknowledgement retries one committed operation with the same key and payload',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),receipts=new Map<string,{id:string}>(),keys:string[]=[];
 let lost=true,writes=0;
 const write=async(key:string)=>{keys.push(key);if(!receipts.has(key)){writes++;receipts.set(key,{id:'SAVED_IMPORT'});}if(lost){lost=false;throw new ApiClientError('Connection interrupted.',503);}return receipts.get(key)!;};
 await assert.rejects(retry.run('tenant-a','/api/v1/imports','POST',{csv:'fixture'},requests.capture(),write,async()=>{}));
 const result=await retry.run('tenant-a','/api/v1/imports','POST',{csv:'fixture'},requests.capture(),write,async()=>{});
 assert.equal(result.id,'SAVED_IMPORT');assert.equal(writes,1);assert.equal(keys[0],keys[1]);
});
test('post-save refresh failure retains mutation identity; only complete success acknowledges the attempt',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),keys:string[]=[];let committed=0;
 const receipts=new Set<string>();const write=async(key:string)=>{keys.push(key);if(!receipts.has(key)){receipts.add(key);committed++;}return {id:'SAVED_INTEGRATION'};};
 await assert.rejects(retry.run('tenant-a','/integrations','POST',{name:'Fixture'},requests.capture(),write,async()=>{throw new ApiClientError('Refresh failed.',503);}));
 // A successful independent read/refresh does not erase the unacknowledged mutation.
 requests.capture().assertCurrent();
 await retry.run('tenant-a','/integrations','POST',{name:'Fixture'},requests.capture(),write,async()=>{});
 assert.equal(keys[0],keys[1]);assert.equal(committed,1);
 await retry.run('tenant-a','/integrations','POST',{name:'Fixture'},requests.capture(),write,async()=>{});
 assert.notEqual(keys[1],keys[2]);assert.equal(committed,2);
});
test('retry identity changes for tenant, endpoint, HTTP method or payload changes',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),keys:string[]=[];
 for(const [tenant,path,method,payload] of [['a','/resource','POST',1],['b','/resource','POST',1],['b','/other','POST',1],['b','/other','PATCH',1],['b','/other','PATCH',2]]){
  await assert.rejects(retry.run(tenant,path,method,{payload},requests.capture(),async(key:string)=>{keys.push(key);throw Error('LOST');},async()=>{}));
 }
 assert.equal(new Set(keys).size,5);
});
test('a stale write cannot run post-save UI effects or acknowledge the new attempt',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),pending=deferred<{id:string}>(),old=requests.capture();let effects=0;
 const oldWork=retry.run('old','/resource','POST',{},old,async()=>pending.promise,async()=>{effects++;});
 requests.replace();const keys:string[]=[];
 await assert.rejects(retry.run('new','/resource','POST',{},requests.capture(),async(key:string)=>{keys.push(key);throw Error('NEW_LOST');},async()=>{}));
 pending.resolve({id:'OLD_SECRET'});await assert.rejects(oldWork,{name:'AbortError'});assert.equal(effects,0);
 await retry.run('new','/resource','POST',{},requests.capture(),async(key:string)=>{keys.push(key);return {};},async()=>{});assert.equal(keys[0],keys[1]);
});
test('a stale post-save read cannot acknowledge the mutation when a new scope is active',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),pending=deferred<void>(),old=requests.capture();let entered=false;
 const work=retry.run('a','/resource','POST',{},old,async()=>({}),async()=>{entered=true;await pending.promise;});
 await Promise.resolve();assert.equal(entered,true);requests.replace();pending.resolve();await assert.rejects(work,{name:'AbortError'});
});
test('client sends explicit tenant/key with Headers objects and keeps private reads uncached',async()=>{
 await withFetch(async calls=>{
  assert.deepEqual(await requestApi('/api/v1/fixture',{headers:new Headers({'X-Tenant-Id':'wrong','Idempotency-Key':'wrong',Accept:'application/json'})},'tenant-a','retry-key'),{saved:true});
  const headers=new Headers(calls[0].init?.headers);assert.equal(headers.get('X-Tenant-Id'),'tenant-a');assert.equal(headers.get('Idempotency-Key'),'retry-key');assert.equal(headers.get('Accept'),'application/json');assert.equal(calls[0].init?.cache,'no-store');
 },async()=>Response.json({data:{saved:true}}));
});
test('HTML/malformed proxy responses preserve auth status and never expose proxy content to forms',async()=>{
 for(const status of [200,401,403,503])await withFetch(async()=>{
  await assert.rejects(requestApi('/api/v1/fixture'),(error:any)=>{assert.ok(error instanceof ApiClientError);assert.equal(error.status,status===200?503:status);assert.doesNotMatch(error.message,/PRIVATE_PROXY|SyntaxError|Unexpected token/);return true;});
 },async()=>new Response('<html>PRIVATE_PROXY</html>',{status}));
});
test('network interruptions become safe retry errors while explicit cancellation remains aborted',async()=>{
 await withFetch(async()=>{await assert.rejects(requestApi('/api/v1/fixture'),(error:any)=>error.status===503&&error.code==='CONNECTION_INTERRUPTED'&&!error.message.includes('PRIVATE'));},async()=>{throw Error('PRIVATE_NETWORK_URL');});
 const abort=new AbortController();abort.abort();
 await withFetch(async()=>{await assert.rejects(requestApi('/api/v1/fixture',{signal:abort.signal}),{name:'AbortError'});},async()=>{throw new DOMException('Aborted.','AbortError');});
});
test('client rejects unverified successful envelopes and retains safe field/conflict/rate error metadata',async()=>{
 for(const data of [null,{},[],{error:{message:'PRIVATE'}},{data:{},error:{message:'PRIVATE'}}])await withFetch(async()=>{
  await assert.rejects(requestApi('/fixture'),(error:any)=>error.status===503&&error.code==='INVALID_RESPONSE'&&!error.message.includes('PRIVATE'));
 },async()=>Response.json(data));
 await withFetch(async()=>{await assert.rejects(requestApi('/fixture'),(error:any)=>{assert.equal(error.status,429);assert.equal(error.code,'RATE_LIMITED');assert.equal(error.retryAfter,15);assert.match(error.message,/Wait\. Email required\./);return true;});},async()=>Response.json({error:{message:'Wait.',code:'RATE_LIMITED',retry_after:15,field_errors:{email:'Email required.',ignored:123}}},{status:429}));
});
