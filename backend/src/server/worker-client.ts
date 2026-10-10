import 'server-only';
import {createClient} from '@supabase/supabase-js';
import {ApiError} from './http';
export function workerClient(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
 if(!url||!key||key.startsWith('sb_publishable_'))throw new ApiError(503,'WORKER_NOT_CONFIGURED','Worker database configuration is incomplete.');
 let valid=false;try{const base=new URL(url);valid=!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/'&&(base.protocol==='https:'||base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname));}catch{}
 if(!valid)throw new ApiError(503,'WORKER_NOT_CONFIGURED','Worker database configuration is incomplete.');
 if(!key.startsWith('sb_secret_')){try{if(JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role!=='service_role')throw new Error();}catch{throw new ApiError(503,'WORKER_NOT_CONFIGURED','A private worker credential is required.');}}
 // Worker handlers use only the narrow worker RPCs; never this client for user APIs/table reads.
 return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})}});
}
