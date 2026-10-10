import test from 'node:test';
import assert from 'node:assert/strict';
const {ClientRequests,MutationRetry}=await import(new URL('../../frontend/src/lib/client-workflow.ts',import.meta.url).href);
const {InvitationFragment,readVerifiedAccount,verifyInvitationReceipt,readMfaSnapshot,enrollAuthenticator,AccountRecoveryError}=await import(new URL('../../frontend/src/lib/account-recovery.ts',import.meta.url).href);
const token='a'.repeat(64),user={id:'verified-user',email:'synthetic@example.com'};
const pendingFactor={id:'factor-a',status:'unverified',friendly_name:'Synthetic authenticator'};
const enrollment={factor_id:'factor-a',secret:'SYNTHETIC_SETUP',qr_code:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='};
const receipt={tenant_id:'agency-a',membership:{id:'member-a',role:'AGENT'}};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve};};
test('invitation fragment survives effect replay after URL scrubbing but never rehydrates after clear',()=>{
 const fragment=new InvitationFragment();let scrubbed=0;
 assert.equal(fragment.read('#token='+token,()=>scrubbed++),token);assert.equal(fragment.read('',()=>scrubbed++),token);assert.equal(scrubbed,1);
 fragment.clear();assert.equal(fragment.read('#token='+token,()=>scrubbed++),'');assert.equal(scrubbed,1);
});
test('invalid, duplicate or ambiguous invitation fragments are scrubbed and cannot supply a token',()=>{
 for(const hash of ['#token=private-invalid','#token='+token+'&token='+token,'#token='+token.toUpperCase(),'#other=value']){
  const fragment=new InvitationFragment();let scrubbed=0;assert.equal(fragment.read(hash,()=>scrubbed++),'');assert.equal(scrubbed,1);
 }
});
test('invitation URL scrub failure cannot retain a bearer token in initialized memory',()=>{
 const fragment=new InvitationFragment();assert.throws(()=>fragment.read('#token='+token,()=>{throw Error('Blocked');}));assert.equal(fragment.read('',()=>{}),'');
});
test('verified account reads require identity/email and bind acceptance to the expected account',async()=>{
 const ticket=new ClientRequests().capture();assert.deepEqual(await readVerifiedAccount(ticket,async(path:string,options:RequestInit)=>{assert.equal(path,'/api/v1/me/memberships');assert.equal(options.signal,ticket.signal);return {user};},user.id),user);
 await assert.rejects(readVerifiedAccount(ticket,async()=>({user:{...user,id:'changed-user'}}),user.id),(e:any)=>e.status===401);
 for(const data of [null,{}, {user:{id:user.id}},{user:{id:'',email:user.email}}])await assert.rejects(readVerifiedAccount(ticket,async()=>data),(e:any)=>e.status===503);
});
test('late verified identity cannot republish after sign-out/unmount even if fetch ignores cancellation',async()=>{
 const requests=new ClientRequests(),pending=deferred<any>();let published=false;
 const work=readVerifiedAccount(requests.capture(),async()=>pending.promise).then(()=>{published=true;});requests.close();requests.replace();pending.resolve({user});await assert.rejects(work,{name:'AbortError'});assert.equal(published,false);
});
test('invitation acceptance requires a concrete membership receipt and refuses malformed success',()=>{
 verifyInvitationReceipt(receipt);
 for(const data of [null,{}, {tenant_id:'agency-a'}, {...receipt,membership:{id:'member-a',role:'OWNER'}}])assert.throws(()=>verifyInvitationReceipt(data),(e:any)=>e.status===503);
});
test('unknown acceptance receipt retains token/payload identity and reuses one committed operation',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),keys:string[]=[],receipts=new Map<string,any>();let writes=0,lost=true;
 const write=async(key:string)=>{keys.push(key);if(!receipts.has(key)){receipts.set(key,receipt);writes++;}if(lost){lost=false;return {}; }return receipts.get(key);};
 const body={token,display_name:'Fixture invitee'},after=async(data:any)=>verifyInvitationReceipt(data);
 await assert.rejects(retry.run(user.id,'/api/v1/team/invitations/accept','POST',body,requests.capture(),write,after));
 await retry.run(user.id,'/api/v1/team/invitations/accept','POST',body,requests.capture(),write,after);assert.equal(writes,1);assert.equal(keys[0],keys[1]);
});
test('account switching explicitly discards the invitation acceptance attempt',async()=>{
 const retry=new MutationRetry(),requests=new ClientRequests(),keys:string[]=[];
 const run=(account:string)=>retry.run(account,'/api/v1/team/invitations/accept','POST',{token,display_name:'Fixture'},requests.capture(),async(key:string)=>{keys.push(key);throw Error('Lost');},async()=>{});
 await assert.rejects(run(user.id));retry.clear();await assert.rejects(run('other-account'));assert.notEqual(keys[0],keys[1]);
});
test('MFA inventory rejects malformed/duplicate factors and invalid recent-verification claims',async()=>{
 const ticket=new ClientRequests().capture();assert.deepEqual(await readMfaSnapshot(ticket,async()=>({factors:[pendingFactor],recent:false})),{factors:[pendingFactor],recent:false});
 for(const data of [null,{factors:[]},{factors:[],recent:'true'},{factors:[null],recent:false},{factors:[{...pendingFactor,status:'unknown'}],recent:false},{factors:[pendingFactor,pendingFactor],recent:false}])await assert.rejects(readMfaSnapshot(ticket,async()=>data),(e:any)=>e.status===503);
});
test('MFA enrollment preflight blocks another POST when a current factor already exists',async()=>{
 for(const status of ['verified','unverified']){
  let posts=0,published:any;await assert.rejects(enrollAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>{if(options.method==='POST')posts++;return {factors:[{...pendingFactor,status}],recent:false};},(data:any)=>published=data),(e:any)=>e.status===422&&!e.uncertain);assert.equal(posts,0);assert.equal(published.factors[0].status,status);
 }
});
test('MFA enrollment requires fresh factor inventory before one explicit POST and minimizes setup projection',async()=>{
 const ticket=new ClientRequests().capture(),calls:string[]=[];let inventories=0;
 const result=await enrollAuthenticator(ticket,async(_path:string,options:RequestInit)=>{assert.equal(options.signal,ticket.signal);calls.push(options.method??'GET');if(!options.method)return {factors:[],recent:false};assert.deepEqual(JSON.parse(options.body as string),{action:'enroll'});return {...enrollment,ignored_private:'not-projected'};},()=>inventories++);
 assert.deepEqual(result,enrollment);assert.deepEqual(calls,['GET','POST']);assert.equal(inventories,1);
});
test('failed preflight cannot enroll and late preflight cannot make a POST after cleanup',async()=>{
 let posts=0;await assert.rejects(enrollAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>{if(options.method==='POST')posts++;throw new AccountRecoveryError('Unavailable');},()=>{}));assert.equal(posts,0);
 const requests=new ClientRequests(),pending=deferred<any>();const work=enrollAuthenticator(requests.capture(),async(_path:string,options:RequestInit)=>{if(options.method==='POST')posts++;return pending.promise;},()=>{});
 requests.close();pending.resolve({factors:[],recent:false});await assert.rejects(work,{name:'AbortError'});assert.equal(posts,0);
});
test('uncertain enrollment transport or malformed setup never retries a POST or exposes returned secrets',async()=>{
 for(const result of [null,{}, {...enrollment,qr_code:'https://private.example/secret'}, {...enrollment,secret:'x'.repeat(513)}, {...enrollment,qr_code:'data:text/html;secret'}]){
  let posts=0;await assert.rejects(enrollAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>{if(!options.method)return {factors:[],recent:false};posts++;return result;},()=>{}),(e:any)=>e.uncertain===true&&e.status===503&&!e.message.includes('private.example'));assert.equal(posts,1);
 }
 let posts=0;await assert.rejects(enrollAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>{if(!options.method)return {factors:[],recent:false};posts++;throw Error('PRIVATE_TRANSPORT');},()=>{}),(e:any)=>e.uncertain===true&&!e.message.includes('PRIVATE'));assert.equal(posts,1);
});
test('enrollment preserves auth-denial status for private-state clearing',async()=>{
 for(const status of [401,403])await assert.rejects(enrollAuthenticator(new ClientRequests().capture(),async(_path:string,options:RequestInit)=>{if(!options.method)return {factors:[],recent:false};throw new AccountRecoveryError('Denied',status);},()=>{}),(e:any)=>e.status===status&&!e.uncertain);
});
test('late enrollment result cannot return its private QR/key into a newer mounted scope',async()=>{
 const requests=new ClientRequests(),pending=deferred<any>(),entered=deferred<void>();let setup:any;
 const work=enrollAuthenticator(requests.capture(),async(_path:string,options:RequestInit)=>{if(!options.method)return {factors:[],recent:false};entered.resolve();return pending.promise;},()=>{}).then((data:any)=>setup=data);
 await entered.promise;requests.close();requests.replace();pending.resolve(enrollment);await assert.rejects(work,{name:'AbortError'});assert.equal(setup,undefined);
});
