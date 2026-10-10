import {deliverQueuedInvitation} from './queued-invitation.ts';
import {ApiError,databaseError} from './http.ts';
type RpcError={message?:string;code?:string};
export type WorkerDb={rpc:(name:string,args?:Record<string,unknown>)=>PromiseLike<{data:any;error:RpcError|null}>};
export async function runNotifications(db:WorkerDb,seed:boolean,clock=Date.now,mail=deliverQueuedInvitation){
 const started=clock();let seeded=0;
 if(seed){const result=await db.rpc('worker_seed_due',{p_limit:100});if(result.error)databaseError(result.error);seeded=result.data.seeded;}
 const jobs:{id:string;state:string;written:number}[]=[];
 for(let count=0;count<20&&clock()-started<20000;count++){
  const claim=await db.rpc('worker_claim_notifications',{p_limit:1});if(claim.error)databaseError(claim.error);const job=claim.data?.[0];if(!job)break;
  let state='LEASE_RECOVERY_PENDING',written=0;
  try{if(job.event_type==='INVITATION_MAIL'){const delivered=await mail(db,job);state=delivered.state;written=0;}else{const result=await db.rpc('worker_finish_notification',{p_job:job.id,p_lease:job.lease_token});
   if(result.error){const failure=await db.rpc('worker_fail_notification',{p_job:job.id,p_lease:job.lease_token,p_code:result.error.message==='UNSUPPORTED_EVENT'?'UNSUPPORTED_EVENT':'NOTIFICATION_WRITE_FAILED'});if(!failure.error)state=failure.data.state;}
   else{state=result.data.state;written=result.data.written??0;}}
  }catch(error){try{const failure=await db.rpc('worker_fail_notification',{p_job:job.id,p_lease:job.lease_token,p_code:error instanceof ApiError&&error.code==='INVITATION_MAIL_FAILED'?'INVITATION_MAIL_FAILED':'TRANSIENT_DATABASE_FAILURE'});if(!failure.error)state=failure.data.state;}catch{/* Expiring fenced lease preserves recovery after network loss. */}}
  if(!['PENDING','SUCCEEDED','CANCELLED','FAILED','STALE','LEASE_RECOVERY_PENDING'].includes(state))throw new ApiError(503,'WORKER_RESULT_INVALID','Worker result could not be verified.');
  jobs.push({id:job.id,state,written});
 }
 const metrics=await db.rpc('worker_notification_metrics');if(metrics.error)databaseError(metrics.error);
 return {seeded,jobs,metrics:metrics.data,duration_ms:Math.max(0,clock()-started)};
}
