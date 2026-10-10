import {api,ApiError,databaseError} from '../server/http.ts';
import {authorizeWorker} from '../server/worker-auth.ts';
import {workerClient} from '../server/worker-client.ts';
import {analysisConfig} from '../server/analysis-provider.ts';
import {runAnalyses} from '../server/analysis-worker.ts';
function ready(request:Request){authorizeWorker(request,process.env.CRON_SECRET);if(new URL(request.url).search)throw new ApiError(422,'VALIDATION_FAILED','Worker configuration belongs on the server.');return workerClient();}
export const run=(request:Request)=>api(async requestId=>{const result=await runAnalyses(ready(request),analysisConfig());console.info(JSON.stringify({event:'analysis_worker',request_id:requestId,...result}));return result;});
export const status=(request:Request)=>api(async()=>{const db=ready(request);const {data,error}=await db.rpc('worker_analysis_metrics');if(error)databaseError(error);return data;});
