import test from 'node:test';
import assert from 'node:assert/strict';
import {manifestFetch,scheduledPrivacy,type ManifestBucket,type ManifestStoreEnv} from '../src/infrastructure/privacy-manifest-store.ts';
import {persistPrivacyManifest,signedPrivacyManifest} from '../src/server/privacy-worker.ts';
const token='test-private-manifest-token'.repeat(2),keys={v1:'a'.repeat(64)};
const config={url:'https://store.example.invalid/manifests',token,activeKey:'v1',keys};
function fixture(){
 const id=crypto.randomUUID(),text=JSON.stringify({format_version:1,job_id:id,sequence:1,tenant_id:crypto.randomUUID(),case_id:crypto.randomUUID(),kind:'LEAD_ERASURE',policy_version:1,prepared_at:'2026-11-12T00:00:00Z',lead_ids:[crypto.randomUUID()]});
 const envelope=signedPrivacyManifest(text,'v1',keys),objects=new Map<string,Uint8Array>();let puts=0;
 const bucket:ManifestBucket={
  async get(key){const value=objects.get(key);return value?{body:new Response(Uint8Array.from(value)).body!,size:value.length,httpEtag:'"test"'}:null;},
  async head(key){return objects.has(key)?{}:null;},
  async put(key,value,options){puts++;assert.equal(options.onlyIf.get('If-None-Match'),'*');if(objects.has(key))return null;objects.set(key,value.slice());return {};},
 };
 const env:ManifestStoreEnv={MANIFESTS:bucket,PRIVACY_MANIFEST_STORE_TOKEN:token,PRIVACY_MANIFEST_KEYS:JSON.stringify(keys),MANIFEST_WRITES_ENABLED:'true',PRIVACY_SCHEDULER_ENABLED:'false',PRIVACY_APP_ORIGIN:'https://app.example.invalid',CRON_SECRET:'cron-secret'.repeat(5)};
 const request=(method='PUT',body=JSON.stringify(envelope),patch:Record<string,string>={})=>new Request(config.url+'/'+id+'.json',{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','If-None-Match':'*',...patch},...(method==='PUT'?{body}:{})});
 return {id,text,envelope,env,bucket,objects,request,puts:()=>puts};
}
test('manifest adapter denies unauthenticated access and exposes no list/delete paths',async()=>{
 const f=fixture();for(const method of ['GET','PUT','DELETE'])assert.equal((await manifestFetch(f.request(method,undefined,{Authorization:'Bearer wrong'}),f.env)).status,401);
 for(const path of ['/manifests','/manifests/not-a-uuid.json','/manifests/'+f.id+'.json?list=true'])assert.equal((await manifestFetch(new Request('https://store.example.invalid'+path,{headers:{Authorization:'Bearer '+token}}),f.env)).status,404);
 assert.equal((await manifestFetch(f.request('DELETE'),f.env)).status,405);assert.equal(f.puts(),0);
});
test('application persists and verifies exact signed bytes through the private adapter',async()=>{
 const f=fixture(),methods:string[]=[];
 const send:typeof fetch=async(url,init)=>{methods.push(init!.method!);return manifestFetch(new Request(url,init),f.env);};
 assert.match(await persistPrivacyManifest(f.text,config,send),/^[a-f0-9]{64}$/);assert.deepEqual(methods,['GET','PUT','GET']);
 const before=f.objects.get('manifests/'+f.id+'.json')!.slice();assert.equal((await manifestFetch(f.request(),f.env)).status,412);assert.deepEqual(f.objects.get('manifests/'+f.id+'.json'),before);
 assert.equal((await manifestFetch(f.request('GET'),f.env)).headers.get('cache-control'),'no-store');
});
test('manifest writes require explicit readiness, conditional create and JSON',async()=>{
 const f=fixture();assert.equal((await manifestFetch(f.request(),{...f.env,MANIFEST_WRITES_ENABLED:'false'})).status,503);
 assert.equal((await manifestFetch(f.request('PUT',undefined,{'If-None-Match':''}),f.env)).status,428);
 assert.equal((await manifestFetch(f.request('PUT',undefined,{'Content-Type':'text/plain'}),f.env)).status,415);assert.equal(f.puts(),0);
});
test('changed signature, wrong job, unknown key and extra customer fields cannot poison an immutable slot',async()=>{
 const f=fixture();for(const value of [{...f.envelope,signature:'b'.repeat(64)},{...f.envelope,key_id:'lost'},{...f.envelope,customer:'PRIVATE'},signedPrivacyManifest(f.text.replace(f.id,crypto.randomUUID()),'v1',keys)])assert.equal((await manifestFetch(f.request('PUT',JSON.stringify(value)),f.env)).status,422);
 assert.equal((await manifestFetch(f.request('PUT','x'.repeat(2*1024*1024+1)),f.env)).status,422);assert.equal(f.puts(),0);
});
test('racing writes stay conditional; bucket lock rejection maps to replay only after existence check',async()=>{
 const f=fixture();let heads=0;
 const race:ManifestBucket={...f.bucket,async head(){return ++heads===1?null:{};},async put(){throw Error('provider details');}};
 assert.equal((await manifestFetch(f.request(),{...f.env,MANIFESTS:race})).status,412);
 const failed:ManifestBucket={...race,async head(){return null;}};const result=await manifestFetch(f.request(),{...f.env,MANIFESTS:failed});assert.equal(result.status,503);assert.equal(await result.text(),'');
 assert.equal((await manifestFetch(f.request(),{...f.env,MANIFESTS:{...f.bucket,async put(){return null;}}})).status,412);
});
test('storage outage, missing configuration and oversized objects give safe failures',async()=>{
 const f=fixture();assert.equal((await manifestFetch(f.request(),{...f.env,PRIVACY_MANIFEST_STORE_TOKEN:''})).status,503);
 const down:ManifestBucket={...f.bucket,async get(){throw Error(token);}};assert.equal(await (await manifestFetch(f.request('GET'),{...f.env,MANIFESTS:down})).text(),'');
 const large:ManifestBucket={...f.bucket,async get(){return {body:new Response('large').body!,size:2*1024*1024+1,httpEtag:'test'};}};assert.equal((await manifestFetch(f.request('GET'),{...f.env,MANIFESTS:large})).status,503);
});
test('scheduler is inert until explicitly enabled and storage marked ready',async()=>{
 const f=fixture();let calls=0;const send:typeof fetch=async()=>{calls++;return new Response(null);};
 assert.deepEqual(await scheduledPrivacy(f.env,send),{state:'DISABLED'});assert.equal(calls,0);
 await assert.rejects(scheduledPrivacy({...f.env,PRIVACY_SCHEDULER_ENABLED:'true',MANIFEST_WRITES_ENABLED:'false'},send));assert.equal(calls,0);
});
test('scheduler sends a bounded authenticated POST only to the configured application',async()=>{
 const f=fixture();let calls=0;
 assert.deepEqual(await scheduledPrivacy({...f.env,PRIVACY_SCHEDULER_ENABLED:'true'},async(url,init)=>{calls++;assert.equal(String(url),'https://app.example.invalid/api/internal/privacy');assert.equal(init?.method,'POST');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer '+f.env.CRON_SECRET);assert.equal(init?.redirect,'error');assert.equal(init?.cache,'no-store');assert.ok(init?.signal);return Response.json({data:{state:'IDLE',processed:0,expired:0}});}),{state:'TRIGGERED'});assert.equal(calls,1);
});
test('scheduler rejects invalid origins, missing secrets, redirects and upstream failures without disclosing them',async()=>{
 const f=fixture(),enabled={...f.env,PRIVACY_SCHEDULER_ENABLED:'true'};let calls=0;const send:typeof fetch=async()=>{calls++;return new Response(null);};
 for(const origin of ['http://app.example.invalid','https://name:secret@app.example.invalid','https://app.example.invalid/path','https://app.example.invalid/?token=secret','https://localhost'])await assert.rejects(scheduledPrivacy({...enabled,PRIVACY_APP_ORIGIN:origin},send));
 await assert.rejects(scheduledPrivacy({...enabled,CRON_SECRET:''},send));assert.equal(calls,0);
 for(const status of [302,401,404,503])await assert.rejects(scheduledPrivacy(enabled,async()=>new Response('PRIVATE',{status})),e=>!(e as Error).message.includes('PRIVATE'));
 await assert.rejects(scheduledPrivacy(enabled,async()=>{throw Error(token);}),e=>!(e as Error).message.includes(token));
});
test('scheduler refuses a successful HTML login page or malformed worker acknowledgement',async()=>{
 const f=fixture(),env={...f.env,PRIVACY_SCHEDULER_ENABLED:'true'};
 for(const body of ['<html>login</html>','x'.repeat(4097),JSON.stringify({data:{state:'IDLE',processed:26,expired:0}}),JSON.stringify({data:{state:'IDLE',processed:0,expired:0},customer:'PRIVATE'})])await assert.rejects(scheduledPrivacy(env,async()=>new Response(body)));
});
