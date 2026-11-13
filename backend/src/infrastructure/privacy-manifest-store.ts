import {z} from 'zod';
import {privacyEnvelopeSchema,privacyManifestSchema} from '../domain/privacy-execution.ts';

const maxBytes=2*1024*1024;
type ObjectBody={body:ReadableStream<Uint8Array>;size:number;httpEtag:string};
export type ManifestBucket={
 get(key:string):Promise<ObjectBody|null>;
 head(key:string):Promise<unknown|null>;
 put(key:string,value:Uint8Array,options:{onlyIf:Headers;httpMetadata:{contentType:string;cacheControl:string}}):Promise<unknown|null>;
};
export type ManifestStoreEnv={
 MANIFESTS:ManifestBucket;
 PRIVACY_MANIFEST_STORE_TOKEN?:string;
 PRIVACY_MANIFEST_KEYS?:string;
 MANIFEST_WRITES_ENABLED?:string;
 PRIVACY_SCHEDULER_ENABLED?:string;
 PRIVACY_APP_ORIGIN?:string;
 CRON_SECRET?:string;
};
const encoder=new TextEncoder();
const reply=(status:number)=>new Response(null,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const secret=(value:unknown):value is string=>typeof value==='string'&&value.length>=32&&value.length<=256&&!/[\r\n]/.test(value);
async function authorized(request:Request,token:string){
 const supplied=request.headers.get('authorization')??'';
 if(supplied.length>264)return false;
 const [actual,expected]=await Promise.all([supplied,'Bearer '+token].map(v=>crypto.subtle.digest('SHA-256',encoder.encode(v))));
 const a=new Uint8Array(actual),b=new Uint8Array(expected);let difference=0;
 for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;
}
async function bytes(request:Request|Response,limit=maxBytes){
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw Error();
 const reader=request.body?.getReader();if(!reader)throw Error();const parts:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error();}parts.push(value);}
 const result=new Uint8Array(size);let offset=0;for(const part of parts){result.set(part,offset);offset+=part.length;}return result;
}
async function verify(body:Uint8Array,id:string,rawKeys:string|undefined){
 const keys=z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),z.string().regex(/^[a-f0-9]{64}$/)).parse(JSON.parse(rawKeys??''));
 const envelope=privacyEnvelopeSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
 const manifest=privacyManifestSchema.parse(JSON.parse(envelope.manifest_text));
 if(manifest.job_id!==id||!Object.hasOwn(keys,envelope.key_id))throw Error();
 const decode=(hex:string)=>Uint8Array.from(hex.match(/../g)!,v=>parseInt(v,16));
 const key=await crypto.subtle.importKey('raw',decode(keys[envelope.key_id]),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('HMAC',key,decode(envelope.signature),encoder.encode('LeadPilot privacy manifest v1\0'+envelope.manifest_text)))throw Error();
}

// The bucket stays private. This interface has no list, overwrite or delete operation.
export async function manifestFetch(request:Request,env:ManifestStoreEnv):Promise<Response>{
 try{
  if(!secret(env.PRIVACY_MANIFEST_STORE_TOKEN))return reply(503);
  if(!await authorized(request,env.PRIVACY_MANIFEST_STORE_TOKEN))return reply(401);
  const url=new URL(request.url),match=/^\/manifests\/([0-9a-f-]{36})\.json$/.exec(url.pathname);
  if(url.protocol!=='https:'||url.search||!match||!z.uuid().safeParse(match[1]).success)return reply(404);
  const key='manifests/'+match[1]+'.json';
  if(request.method==='GET'){
   const object=await env.MANIFESTS.get(key);if(!object)return reply(404);
   if(object.size>maxBytes){await object.body.cancel();return reply(503);}
   return new Response(object.body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',ETag:object.httpEtag}});
  }
  if(request.method!=='PUT')return reply(405);
  if(env.MANIFEST_WRITES_ENABLED!=='true')return reply(503);
  if(request.headers.get('if-none-match')!=='*')return reply(428);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return reply(415);
  let body:Uint8Array;
  try{body=await bytes(request);await verify(body,match[1],env.PRIVACY_MANIFEST_KEYS);}catch{return reply(422);}
  if(await env.MANIFESTS.head(key))return reply(412);
  try{
   const saved=await env.MANIFESTS.put(key,body,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{contentType:'application/json',cacheControl:'no-store'}});
   return reply(saved===null?412:201);
  }catch{
   // R2 locks may reject before checking the conditional header. Confirm existence
   // before mapping a concurrent locked create to 412; never acknowledge lost writes.
   return reply(await env.MANIFESTS.head(key)?412:503);
  }
 }catch{return reply(503);}
}

export async function scheduledPrivacy(env:ManifestStoreEnv,send:typeof fetch=fetch){
 if(env.PRIVACY_SCHEDULER_ENABLED!=='true')return {state:'DISABLED' as const};
 try{
  if(env.MANIFEST_WRITES_ENABLED!=='true'||!secret(env.CRON_SECRET))throw Error();
  const origin=new URL(env.PRIVACY_APP_ORIGIN??'');
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||origin.hostname==='localhost'||origin.hostname==='127.0.0.1'||origin.hostname==='[::1]')throw Error();
  const response=await send(new URL('/api/internal/privacy',origin),{method:'POST',headers:{Authorization:'Bearer '+env.CRON_SECRET},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(45000)});
  if(!response.ok){await response.body?.cancel();throw Error();}
  const result=z.object({data:z.object({state:z.enum(['IDLE','PENDING','ANONYMIZED','STALE']),processed:z.number().int().min(0).max(25),expired:z.number().int().min(0).max(25)}).strict()}).strict();
  result.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(response,4096))));
  return {state:'TRIGGERED' as const};
 }catch{throw new Error('Privacy schedule failed. Check protected configuration and worker status before retrying.');}
}

export default {
 fetch:manifestFetch,
 async scheduled(_controller:unknown,env:ManifestStoreEnv){await scheduledPrivacy(env);},
};
