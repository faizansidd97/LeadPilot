import {api,ApiError} from '../server/http.ts';
import {workerClient} from '../server/worker-client.ts';
import {validate,uuid} from '../domain/contracts.ts';
import {processSignedIntake} from '../server/signed-intake.ts';
export async function POST(request:Request,context:{params:Promise<{integrationId:string}>}){
 let replayed=false;const response=await api(async requestId=>{
  const id=validate(uuid,(await context.params).integrationId);if(new URL(request.url).search)throw new ApiError(422,'VALIDATION_FAILED','Use the integration path and signed body.');
  const data=await processSignedIntake(request,id,workerClient(),requestId);replayed=data.replayed;return data;
 },201);if(replayed)return new Response(response.body,{status:200,headers:response.headers});return response;
}
