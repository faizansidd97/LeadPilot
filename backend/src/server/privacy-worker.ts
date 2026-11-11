import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {privacyEnvelopeSchema,privacyManifestSchema} from '../domain/privacy-execution.ts';
import {ApiError,databaseError} from './http.ts';

type Rpc={rpc:(name:string,args?:Record<string,unknown>)=>PromiseLike<{data:any;error:{message?:string;code?:string}|null}>};
type Config={url:string;token:string;activeKey:string;keys:Record<string,string>};
export function privacyWorkerConfig(env:Record<string,string|undefined>):Config{
 try{
  if(env.PRIVACY_EXECUTION_ENABLED!=='true')throw Error();
  const base=new URL(env.PRIVACY_MANIFEST_STORE_URL??'');
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.hostname==='localhost'||base.hostname==='127.0.0.1')throw Error();
  const token=env.PRIVACY_MANIFEST_STORE_TOKEN??'',activeKey=env.PRIVACY_MANIFEST_ACTIVE_KEY??'';
  const keys=z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),z.string().regex(/^[a-f0-9]{64}$/)).parse(JSON.parse(env.PRIVACY_MANIFEST_KEYS??''));
  if(token.length<32||/[\r\n]/.test(token)||!Object.hasOwn(keys,activeKey))throw Error();
  return {url:base.href.replace(/\/$/,''),token,activeKey,keys};
 }catch{throw new ApiError(503,'PRIVACY_NOT_CONFIGURED','Privacy execution requires an approved independent manifest store and retained signing keys.');}
}
const invalid=()=>new ApiError(503,'PRIVACY_MANIFEST_UNVERIFIED','The independent privacy manifest could not be verified. No cleanup was dispatched.');
export function signedPrivacyManifest(text:string,keyId:string,keys:Record<string,string>){
 privacyManifestSchema.parse(JSON.parse(text));if(!keys[keyId])throw invalid();
 return {format_version:1 as const,key_id:keyId,manifest_text:text,signature:createHmac('sha256',Buffer.from(keys[keyId],'hex')).update('LeadPilot privacy manifest v1\0'+text).digest('hex')};
}
export function verifyPrivacyEnvelope(value:unknown,keys:Record<string,string>){
 try{
  const envelope=privacyEnvelopeSchema.parse(value);const key=keys[envelope.key_id];if(!key)throw Error();
  const expected=createHmac('sha256',Buffer.from(key,'hex')).update('LeadPilot privacy manifest v1\0'+envelope.manifest_text).digest();
  if(!timingSafeEqual(expected,Buffer.from(envelope.signature,'hex')))throw Error();
  return {envelope,manifest:privacyManifestSchema.parse(JSON.parse(envelope.manifest_text)),digest:createHash('sha256').update(envelope.manifest_text).digest('hex')};
 }catch{throw invalid();}
}
async function limitedJson(response:Response){
 if(!response.body)throw invalid();const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;
 while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>2*1024*1024){await reader.cancel();throw invalid();}parts.push(value);}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function persistPrivacyManifest(text:string,config:Config,send:typeof fetch=fetch){
 try{
  const current=signedPrivacyManifest(text,config.activeKey,config.keys),id=privacyManifestSchema.parse(JSON.parse(text)).job_id,url=config.url+'/'+id+'.json';
  const request=(method:string,body?:string)=>send(url,{method,body,headers:{Authorization:'Bearer '+config.token,...(body?{'Content-Type':'application/json','If-None-Match':'*'}:{})},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
  let response=await request('GET');
  if(response.status===404){await response.body?.cancel();const put=await request('PUT',JSON.stringify(current));if(!put.ok&&put.status!==412){await put.body?.cancel();throw invalid();}await put.body?.cancel();response=await request('GET');}
  if(!response.ok){await response.body?.cancel();throw invalid();}
  const saved=verifyPrivacyEnvelope(await limitedJson(response),config.keys);
  if(saved.envelope.manifest_text!==text)throw invalid();return saved.digest;
 }catch{throw invalid();}
}
export async function runPrivacyWorker(db:Rpc,config:Config,send:typeof fetch=fetch){
 const claim=await db.rpc('worker_claim_privacy');if(claim.error)databaseError(claim.error);
 let state='IDLE',processed=0;
 if(claim.data!==null){
  const parsed=z.object({id:z.uuid(),lease:z.uuid(),manifest_text:z.string().max(1024*1024)}).strict().safeParse(claim.data);if(!parsed.success)throw invalid();
  const manifest=privacyManifestSchema.parse(JSON.parse(parsed.data.manifest_text));if(manifest.job_id!==parsed.data.id)throw invalid();
  const digest=await persistPrivacyManifest(parsed.data.manifest_text,config,send);
  const applied=await db.rpc('worker_apply_privacy',{p_job:parsed.data.id,p_lease:parsed.data.lease,p_manifest_digest:digest});if(applied.error)databaseError(applied.error);
  const result=z.object({state:z.enum(['PENDING','ANONYMIZED','STALE']),processed:z.number().int().min(0).max(25)}).strict().safeParse(applied.data);if(!result.success)throw invalid();state=result.data.state;processed=result.data.processed;
 }
 const expiry=await db.rpc('worker_expire_privacy');if(expiry.error)databaseError(expiry.error);
 const expired=z.object({expired:z.number().int().min(0).max(25)}).strict().safeParse(expiry.data);if(!expired.success)throw invalid();
 return {state,processed,expired:expired.data.expired};
}

// The operator supplies a complete independent export plus an out-of-band digest.
// This never infers completeness from the restored database or an object listing.
export async function replayPrivacyRestore(db:Rpc,bytes:Uint8Array,expectedDigest:string,keys:Record<string,string>,finish=false){
 if(!/^[a-f0-9]{64}$/.test(expectedDigest)||bytes.length>16*1024*1024||createHash('sha256').update(bytes).digest('hex')!==expectedDigest)throw invalid();
 let records:ReturnType<typeof verifyPrivacyEnvelope>[];
 try{
  const bundle=z.object({format_version:z.literal(1),manifests:z.array(privacyEnvelopeSchema).max(10000)}).strict().parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  records=bundle.manifests.map(v=>verifyPrivacyEnvelope(v,keys));
  if(new Set(records.map(r=>r.manifest.job_id)).size!==records.length)throw Error();
  records.sort((a,b)=>a.manifest.sequence-b.manifest.sequence);
 }catch{throw invalid();}
 const call=async(name:string,args:Record<string,unknown>)=>{const result=await db.rpc(name,args);if(result.error)databaseError(result.error);return result.data;};
 const begin=await call('worker_privacy_restore_begin',{p_checkpoint:expectedDigest,p_count:records.length});if(begin?.blocked!==true)throw invalid();
 for(const record of records){const value=await call('worker_privacy_restore_apply',{p_checkpoint:expectedDigest,p_manifest_text:record.envelope.manifest_text});if(value?.applied!==true)throw invalid();}
 if(finish){const value=await call('worker_privacy_restore_finish',{p_checkpoint:expectedDigest});if(value?.blocked!==false)throw invalid();}
 return {replayed:records.length,blocked:!finish};
}
