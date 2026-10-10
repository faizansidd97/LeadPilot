import {platformHealthSchema,platformHealthAlerts} from '../domain/platform-health.ts';
type Environment=Record<string,string|undefined>;
export function monitorConfiguration(env:Environment) {
 let url:URL;
 try{url=new URL(env.APP_URL??'');}catch{throw Error('INVALID_MONITOR_CONFIGURATION');}
 const secret=env.CRON_SECRET;
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
    ['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!secret||secret.length<32||secret.length>512||!/^[A-Za-z0-9_-]+$/.test(secret))throw Error('INVALID_MONITOR_CONFIGURATION');
 return {url:new URL('/api/internal/health',url),secret};
}
const unavailable=()=>({status:'UNAVAILABLE' as const,reason:'HEALTH_NOT_VERIFIED',scheduler_verified:false,release_accepted:false});
export async function checkPlatformHealth(env:Environment,fetcher:typeof fetch=fetch,clock:()=>number=Date.now) {
 // Configuration errors are separate from a reachable but alerting application.
 const config=monitorConfiguration(env);
 try{
  const response=await fetcher(config.url,{method:'GET',headers:{Authorization:'Bearer '+config.secret,Accept:'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)});
  if(response.status!==200||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'){
   await response.body?.cancel();return unavailable();
  }
  if(!response.body)return unavailable();
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  let body:unknown;
  try{
   while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>16384)throw Error('BODY_LIMIT');chunks.push(next.value);}
   body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  // A strict envelope also prevents unexpected diagnostic/customer fields from escaping.
  if(!body||typeof body!=='object'||Object.keys(body).length!==1||!('data' in body))return unavailable();
  const parsed=platformHealthSchema.safeParse(body.data);if(!parsed.success)return unavailable();
  const age=clock()-Date.parse(parsed.data.captured_at);
  // Local monitor policy; not a purchased SLA or scheduler heartbeat.
  if(!Number.isFinite(age)||age>120000||age< -30000)return unavailable();
  return {status:parsed.data.alert?'ATTENTION' as const:'NO_ALERTS' as const,
   snapshot:parsed.data,alerts:platformHealthAlerts(parsed.data),scheduler_verified:false,release_accepted:false};
 }catch{return unavailable();}
}
