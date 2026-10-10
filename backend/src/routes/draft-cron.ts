import {api,ApiError,databaseError} from '../server/http.ts';
import {authorizeWorker} from '../server/worker-auth.ts';
import {workerClient} from '../server/worker-client.ts';
import {draftConfig} from '../server/draft-provider.ts';
import {runDrafts} from '../server/draft-worker.ts';
function ready(request:Request){authorizeWorker(request,process.env.CRON_SECRET);if(new URL(request.url).search)throw new ApiError(422,'VALIDATION_FAILED','Draft worker configuration belongs on the server.');return workerClient();}
export const run=(request:Request)=>api(async requestId=>{const result=await runDrafts(ready(request),draftConfig());console.info(JSON.stringify({event:'draft_worker',request_id:requestId,...result}));return result;});
export const status=(request:Request)=>api(async()=>{const db=ready(request);const {data,error}=await db.rpc('worker_draft_metrics');if(error)databaseError(error);return data;});
