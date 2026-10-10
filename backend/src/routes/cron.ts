import {z} from 'zod';
import {api,readJson,databaseError,ApiError} from '@leadpilot/backend/server/http';
import {authorizeWorker} from '@leadpilot/backend/server/worker-auth';
import {workerClient} from '@leadpilot/backend/server/worker-client';
import {runNotifications} from '@leadpilot/backend/server/notification-worker';
import {validate} from '@leadpilot/backend/domain/contracts';
function ready(request:Request){authorizeWorker(request,process.env.CRON_SECRET);if(new URL(request.url).search)throw new ApiError(422,'VALIDATION_FAILED','Worker bounds are configured by the server.');return workerClient();}
const run=(request:Request,seed:boolean)=>api(async requestId=>{
 const db=ready(request),result=await runNotifications(db,seed);
 // Operational metadata only; no customer text, recipient emails, tokens or provider errors.
 console.info(JSON.stringify({event:'notification_worker',request_id:requestId,seeded:result.seeded,jobs:result.jobs,duration_ms:result.duration_ms,metrics:result.metrics}));return result;
});
export const followUps=(request:Request)=>run(request,true);
export const jobs=(request:Request)=>run(request,false);
export const status=(request:Request)=>api(async()=>{const db=ready(request);const {data,error}=await db.rpc('worker_notification_metrics');if(error)databaseError(error);return data;});
export const retry=(request:Request)=>api(async requestId=>{const db=ready(request),input=validate(z.object({job_id:z.uuid(),expected_attempts:z.number().int().min(1).max(3)}).strict(),await readJson(request));
 const {data,error}=await db.rpc('worker_requeue_notification',{p_job:input.job_id,p_expected_attempts:input.expected_attempts,p_request_id:requestId});if(error)databaseError(error);console.info(JSON.stringify({event:'notification_job_requeued',request_id:requestId,job_id:input.job_id}));return data;
});
