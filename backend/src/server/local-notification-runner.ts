import {createClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {rename} from 'node:fs/promises';
import {runNotifications,type WorkerDb} from './notification-worker.ts';

type Environment=Record<string,string|undefined>;
export const LOCAL_INTERVAL_MS=60_000;
export async function replaceLocalRunnerStatus(temp:URL,target:URL,options:{replace?:typeof rename;pause?:(ms:number)=>Promise<void>}={}){
 const replace=options.replace??rename,pause=options.pause??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 // A Windows reader can briefly block replacement. Retry only the same file rename, never the worker tick.
 for(let attempt=0;;attempt++){
  try{await replace(temp,target);return;}catch(error){
   if(attempt>=4||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code??''))throw error;
   await pause(50*2**attempt);
  }
 }
}
const allowed=new Set(['worker_seed_due','worker_claim_notifications','worker_finish_notification',
 'worker_fail_notification','worker_notification_metrics','worker_prepare_invitation_mail','worker_complete_invitation_mail']);
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const metricsSchema=z.object({due_lag_seconds:count,outbox_lag_seconds:count,pending_jobs:count,
 failed_jobs:count,cleaned_limit_windows:count.max(100),alert:z.boolean()}).strict().refine(m=>
 m.alert===(m.due_lag_seconds>900||m.outbox_lag_seconds>900||m.failed_jobs>0));
const resultSchema=z.object({seeded:count.max(100),jobs:z.array(z.object({id:z.uuid(),
 state:z.enum(['PENDING','SUCCEEDED','CANCELLED','FAILED','STALE','LEASE_RECOVERY_PENDING']),written:count.max(100)}).strict()).max(20),
 metrics:metricsSchema,duration_ms:count}).strict();

export function localRunnerConfiguration(env:Environment){
 const invalid=()=>Error('LOCAL_RUNNER_CONFIGURATION_INVALID');
 let app:URL,base:URL;
 try{app=new URL(env.APP_URL??'');base=new URL(env.NEXT_PUBLIC_SUPABASE_URL??'');}catch{throw invalid();}
 // Development-only activation; no alternate application endpoint or mail/provider dispatch.
 if(app.href!=='http://localhost:4000/'||base.protocol!=='https:'||base.username||base.password||
    base.search||base.hash||base.pathname!=='/'||base.port||
    ['localhost','127.0.0.1','[::1]'].includes(base.hostname)||env.INVITATION_MAIL_URL?.trim()||env.INVITATION_MAIL_TOKEN?.trim())throw invalid();
 const key=env.SUPABASE_SERVICE_ROLE_KEY;
 if(!key||key.length>8192||!(/^[A-Za-z0-9._-]+$/).test(key))throw invalid();
 if(!key.startsWith('sb_secret_')){
  try{if(key.split('.').length!==3||JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role!=='service_role')throw invalid();}
  catch{throw invalid();}
 }
 return {base,key};
}

export function summarizeNotificationRun(value:unknown){
 const result=resultSchema.parse(value);
 return {seeded:result.seeded,claimed:result.jobs.length,
  succeeded:result.jobs.filter(j=>j.state==='SUCCEEDED').length,
  cancelled:result.jobs.filter(j=>j.state==='CANCELLED').length,
  needs_recovery:result.jobs.filter(j=>['PENDING','FAILED','STALE','LEASE_RECOVERY_PENDING'].includes(j.state)).length,
  notifications_written:result.jobs.reduce((sum,j)=>sum+j.written,0),metrics:result.metrics,duration_ms:result.duration_ms};
}
export type TickResult={status:'PASS';summary:ReturnType<typeof summarizeNotificationRun>}|{status:'UNAVAILABLE';reason:'WORKER_RUN_NOT_VERIFIED'};

export async function runLocalNotificationTick(env:Environment,stop:AbortSignal,fetcher:typeof fetch=fetch):Promise<TickResult>{
 const config=localRunnerConfiguration(env);
 const signal=AbortSignal.any([stop,AbortSignal.timeout(45_000)]);
 const client=createClient(config.base.href,config.key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
  global:{fetch:async(input,init)=>{
   signal.throwIfAborted();
   const url=new URL(input instanceof Request?input.url:String(input));
   if(url.origin!==config.base.origin||url.search||!allowed.has(url.pathname.replace(/^\/rest\/v1\/rpc\//,''))||
      !url.pathname.startsWith('/rest/v1/rpc/')||init?.method!=='POST')throw Error('WORKER_SCOPE_INVALID');
   const response=await fetcher(input,{...init,cache:'no-store',redirect:'error',
    signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])});
   // Bound private RPC responses before the SDK parses them. Never expose raw errors/body.
   const reader=response.body?.getReader();if(!reader)throw Error('WORKER_RESPONSE_INVALID');
   const chunks:Uint8Array[]=[];let bytes=0;
   try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;
    if(bytes>32_768)throw Error('WORKER_RESPONSE_LIMIT');chunks.push(next.value);}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   return new Response(Buffer.concat(chunks),{status:response.status,headers:response.headers});
  }}});
 const db:WorkerDb={rpc:(name,args)=>{
  if(!allowed.has(name))throw Error('WORKER_SCOPE_INVALID');
  return client.rpc(name,args);
 }};
 // This dedicated adapter cannot send mail even if another module changes process.env.
 const linkOnly=async(database:WorkerDb,job:{id:string;lease_token:string})=>{
  const prepared=await database.rpc('worker_prepare_invitation_mail',{p_job:job.id,p_lease:job.lease_token});
  if(prepared.error)throw Error('INVITATION_PREPARATION_FAILED');
  const completed=await database.rpc('worker_complete_invitation_mail',{p_job:job.id,p_lease:job.lease_token,
   p_result:prepared.data?.available===true?'LINK_ONLY':'INVITATION_UNAVAILABLE'});
  if(completed.error)throw Error('INVITATION_COMPLETION_FAILED');return completed.data;
 };
 try{return {status:'PASS',summary:summarizeNotificationRun(await runNotifications(db,true,()=>Math.floor(performance.now()),linkOnly))};}
 catch{return {status:'UNAVAILABLE',reason:'WORKER_RUN_NOT_VERIFIED'};}
}

type LoopOptions={signal:AbortSignal;tick:(signal:AbortSignal)=>Promise<TickResult>;
 record:(value:TickResult)=>Promise<void>;clock?:()=>number;
 wait?:(ms:number,signal:AbortSignal)=>Promise<void>};
export async function localNotificationLoop({signal,tick,record,clock=()=>performance.now(),wait=waitForNextRun}:LoopOptions){
 while(!signal.aborted){
  const started=clock();let result:TickResult;
  try{result=await tick(signal);}catch{result={status:'UNAVAILABLE',reason:'WORKER_RUN_NOT_VERIFIED'};}
  if(signal.aborted)break;
  await record(result);
  // One awaited run at a time; after a slow run, skip missed ticks rather than burst catch-up.
  const elapsed=Math.max(0,clock()-started);
  try{await wait(elapsed<LOCAL_INTERVAL_MS?LOCAL_INTERVAL_MS-elapsed:LOCAL_INTERVAL_MS,signal);}
  catch{if(!signal.aborted)throw Error('LOCAL_RUNNER_WAIT_FAILED');}
 }
}
export function waitForNextRun(ms:number,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  if(signal.aborted){reject(Error('STOPPED'));return;}
  const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);reject(Error('STOPPED'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},ms);
  signal.addEventListener('abort',stop,{once:true});
 });
}
