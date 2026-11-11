import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {privacyWorkerConfig,signedPrivacyManifest,verifyPrivacyEnvelope,persistPrivacyManifest,runPrivacyWorker,replayPrivacyRestore} from '../src/server/privacy-worker.ts';
const keys={v1:'a'.repeat(64),v2:'b'.repeat(64)};
const config={url:'https://manifests.example.invalid/retained',token:'private-test-token'.repeat(3),activeKey:'v2',keys};
const manifest=(id=crypto.randomUUID())=>JSON.stringify({format_version:1,job_id:id,sequence:1,tenant_id:crypto.randomUUID(),case_id:crypto.randomUUID(),kind:'LEAD_ERASURE',policy_version:1,prepared_at:'2026-11-12T00:00:00.000000Z',lead_ids:[crypto.randomUUID()]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const env={PRIVACY_EXECUTION_ENABLED:'true',PRIVACY_MANIFEST_STORE_URL:config.url,PRIVACY_MANIFEST_STORE_TOKEN:config.token,PRIVACY_MANIFEST_ACTIVE_KEY:'v2',PRIVACY_MANIFEST_KEYS:JSON.stringify(keys)};

test('privacy configuration fails closed without explicit enablement, HTTPS store, token and retained active key',()=>{
 assert.deepEqual(privacyWorkerConfig(env),config);
 for(const patch of [{PRIVACY_EXECUTION_ENABLED:'false'},{PRIVACY_MANIFEST_STORE_URL:'http://example.invalid'},{PRIVACY_MANIFEST_STORE_URL:'https://name:secret@example.invalid'},{PRIVACY_MANIFEST_STORE_TOKEN:''},{PRIVACY_MANIFEST_KEYS:'broken'},{PRIVACY_MANIFEST_ACTIVE_KEY:'lost'}])assert.throws(()=>privacyWorkerConfig({...env,...patch}),e=>(e as Error).message.includes('independent manifest')&&!(e as Error).message.includes(config.token));
});
test('manifest signatures bind exact scope; old retained keys verify but changed/unknown/duplicate scope cannot',()=>{
 const text=manifest(),signed=signedPrivacyManifest(text,'v1',keys);assert.equal(verifyPrivacyEnvelope(signed,keys).envelope.manifest_text,text);
 for(const value of [{...signed,manifest_text:text+' '},{...signed,key_id:'missing'},{...signed,signature:'f'.repeat(64)},{...signed,customer:'PRIVATE'}])assert.throws(()=>verifyPrivacyEnvelope(value,keys),/could not be verified/);
 const invalid=JSON.parse(text);invalid.lead_ids.push(invalid.lead_ids[0]);assert.throws(()=>signedPrivacyManifest(JSON.stringify(invalid),'v1',keys));
});
test('independent store conditional create must be read back and verified before returning a cleanup acknowledgement',async()=>{
 const text=manifest(),calls:{method:string;headers:Headers}[]=[];let saved:unknown=null;
 const send:typeof fetch=async(url,init)=>{assert.ok(String(url).startsWith(config.url));assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.ok(init?.signal);const headers=new Headers(init?.headers);calls.push({method:init!.method!,headers});
  if(init?.method==='PUT'){assert.equal(headers.get('If-None-Match'),'*');saved=JSON.parse(String(init.body));return new Response(null,{status:201});}
  return saved?json(saved):new Response(null,{status:404});
 };
 const digest=await persistPrivacyManifest(text,config,send);assert.equal(digest,createHash('sha256').update(text).digest('hex'));assert.deepEqual(calls.map(c=>c.method),['GET','PUT','GET']);
 assert.ok(calls.every(c=>c.headers.get('Authorization')==='Bearer '+config.token));
});
test('store replay accepts an already retained old-key document without overwrite; mismatched object fails',async()=>{
 const text=manifest();let puts=0;const send:typeof fetch=async(_url,init)=>{if(init?.method==='PUT')puts++;return json(signedPrivacyManifest(text,'v1',keys));};
 await persistPrivacyManifest(text,config,send);assert.equal(puts,0);
 await assert.rejects(persistPrivacyManifest(text,config,async()=>json(signedPrivacyManifest(manifest(),'v1',keys))),/No cleanup was dispatched/);
});
test('conditional write races require verified readback; redirects, oversized and failed store responses do not acknowledge',async()=>{
 const text=manifest();let reads=0;
 const send:typeof fetch=async(_url,init)=>init?.method==='PUT'?new Response(null,{status:412}):++reads===1?new Response(null,{status:404}):json(signedPrivacyManifest(text,'v1',keys));
 await persistPrivacyManifest(text,config,send);
 for(const status of [302,401,500])await assert.rejects(persistPrivacyManifest(text,config,async()=>new Response(null,{status})),/No cleanup was dispatched/);
 await assert.rejects(persistPrivacyManifest(text,config,async()=>new Response('x'.repeat(2*1024*1024+1))),/No cleanup was dispatched/);
});
test('worker never applies or expires after unverified store acknowledgement; original lease can expire for retry',async()=>{
 const text=manifest(),id=JSON.parse(text).job_id,calls:string[]=[];
 await assert.rejects(runPrivacyWorker({rpc:async(name)=>{calls.push(name);return {data:{id,lease:crypto.randomUUID(),manifest_text:text},error:null};}},config,async()=>new Response(null,{status:500})),/No cleanup was dispatched/);
 assert.deepEqual(calls,['worker_claim_privacy']);
});
test('worker passes original manifest digest to one bounded apply and validates expiry counters',async()=>{
 const text=manifest(),id=JSON.parse(text).job_id,lease=crypto.randomUUID(),calls:string[]=[];
 const result=await runPrivacyWorker({rpc:async(name,args)=>{calls.push(name);if(name==='worker_claim_privacy')return {data:{id,lease,manifest_text:text},error:null};
 if(name==='worker_apply_privacy'){assert.deepEqual(args,{p_job:id,p_lease:lease,p_manifest_digest:createHash('sha256').update(text).digest('hex')});return {data:{state:'PENDING',processed:25},error:null};}return {data:{expired:2},error:null};}},config,async()=>json(signedPrivacyManifest(text,'v1',keys)));
 assert.deepEqual(result,{state:'PENDING',processed:25,expired:2});assert.deepEqual(calls,['worker_claim_privacy','worker_apply_privacy','worker_expire_privacy']);
});
test('restore validates every signature and the independent bundle digest before blocking or changing the database',async()=>{
 const text=manifest(),envelope=signedPrivacyManifest(text,'v1',keys),bundle=Buffer.from(JSON.stringify({format_version:1,manifests:[envelope]})),hash=createHash('sha256').update(bundle).digest('hex');let calls=0;
 const db={rpc:async()=>{calls++;return {data:null,error:null};}};
 await assert.rejects(replayPrivacyRestore(db,bundle,'0'.repeat(64),keys));assert.equal(calls,0);
 await assert.rejects(replayPrivacyRestore(db,bundle,hash,{}));assert.equal(calls,0);
 const duplicate=Buffer.from(JSON.stringify({format_version:1,manifests:[envelope,envelope]}));await assert.rejects(replayPrivacyRestore(db,duplicate,createHash('sha256').update(duplicate).digest('hex'),keys));assert.equal(calls,0);
});
test('restore defaults to a blocked gate, resumes the exact checkpoint and only explicitly releases after all manifests',async()=>{
 const text=manifest(),bundle=Buffer.from(JSON.stringify({format_version:1,manifests:[signedPrivacyManifest(text,'v1',keys)]})),hash=createHash('sha256').update(bundle).digest('hex'),calls:string[]=[];
 const db={rpc:async(name:string,args?:Record<string,unknown>)=>{assert.equal(args?.p_checkpoint,hash);calls.push(name);return {data:name==='worker_privacy_restore_begin'?{blocked:true}:name==='worker_privacy_restore_apply'?{applied:true}:{blocked:false},error:null};}};
 assert.deepEqual(await replayPrivacyRestore(db,bundle,hash,keys),{replayed:1,blocked:true});assert.ok(!calls.includes('worker_privacy_restore_finish'));
 assert.deepEqual(await replayPrivacyRestore(db,bundle,hash,keys,true),{replayed:1,blocked:false});assert.equal(calls.at(-1),'worker_privacy_restore_finish');
});
test('partial restore failure never opens the gate or proceeds to later manifests',async()=>{
 const text=manifest(),bundle=Buffer.from(JSON.stringify({format_version:1,manifests:[signedPrivacyManifest(text,'v1',keys)]})),hash=createHash('sha256').update(bundle).digest('hex'),calls:string[]=[];
 await assert.rejects(replayPrivacyRestore({rpc:async(name)=>{calls.push(name);return name==='worker_privacy_restore_begin'?{data:{blocked:true},error:null}:{data:null,error:{message:'PRIVATE_PROVIDER_ERROR'}};}},bundle,hash,keys,true),e=>!(e as Error).message.includes('PRIVATE_PROVIDER_ERROR'));
 assert.deepEqual(calls,['worker_privacy_restore_begin','worker_privacy_restore_apply']);
});
