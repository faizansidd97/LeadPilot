import {api} from '../server/http.ts';
import {readPlatformHealth} from '../server/health-read.ts';
import {workerClient} from '../server/worker-client.ts';
export const GET=(request:Request)=>api(()=>readPlatformHealth(request,process.env.CRON_SECRET,()=>workerClient().rpc('worker_health_snapshot')));
