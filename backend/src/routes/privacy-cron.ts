import {api,ApiError} from '../server/http';
import {authorizeWorker} from '../server/worker-auth';
import {workerClient} from '../server/worker-client';
import {privacyWorkerConfig,runPrivacyWorker} from '../server/privacy-worker';
export const POST=(request:Request)=>api(async()=>{
 authorizeWorker(request,process.env.CRON_SECRET);if(new URL(request.url).search)throw new ApiError(422,'VALIDATION_FAILED','Worker bounds are configured by the server.');
 const config=privacyWorkerConfig(process.env);return runPrivacyWorker(workerClient(),config);
});
