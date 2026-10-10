import {AnalysisFailure} from '../domain/analysis.ts';
import {preparedProviderRequestId} from '../domain/ai-attempts.ts';
import {renderDraft} from '../domain/drafts.ts';
import {requestDraft,draftConfig} from './draft-provider.ts';
import {databaseError} from './http.ts';
import type {WorkerDb} from './notification-worker.ts';
export async function runDrafts(db:WorkerDb,config:ReturnType<typeof draftConfig>,provider=requestDraft,clock=Date.now){
 const started=clock(),requestId=crypto.randomUUID(),jobs:{id:string;state:string}[]=[];
 const base=await db.rpc('worker_set_ai_policy',{p_enabled:config.base.enabled,p_model:config.base.model,p_languages:config.base.languages,p_rubric_approved:config.base.enabled,p_request_id:requestId});if(base.error)databaseError(base.error);
 const policy=await db.rpc('worker_set_draft_policy',{p_enabled:config.enabled,p_request_id:requestId});if(policy.error)databaseError(policy.error);
 for(let n=0;n<3&&clock()-started<35000;n++){
  const claim=await db.rpc('worker_claim_draft',{p_request_id:requestId});if(claim.error)databaseError(claim.error);if(!claim.data)break;
  const job=claim.data,args={p_job:job.id,p_lease:job.lease_token,p_request_id:requestId};let tokens:number|null=0,state='LEASE_RECOVERY_PENDING';
  try{const prepared=await db.rpc('worker_prepare_draft',args);if(prepared.error)throw new AnalysisFailure('TRANSIENT_DATABASE_FAILURE',true,0);if(!prepared.data){jobs.push({id:job.id,state:'CANCELLED'});continue;}
   const providerRequestId=preparedProviderRequestId(prepared.data);
   tokens=null;const context=prepared.data,sent=clock(),response=await provider(context.snapshot,context.snapshot.draft_options,{...config.base,model:context.model},providerRequestId);tokens=response.tokens;
   const result=renderDraft(response.analysis,context.snapshot,context.snapshot.draft_options,context.languages);
   const saved=await db.rpc('worker_finish_draft',{...args,p_result:result,p_tokens:tokens,p_latency:Math.min(90000,Math.max(0,clock()-sent))});if(saved.error)throw new AnalysisFailure('TRANSIENT_DATABASE_FAILURE',true,tokens);state=saved.data.state;
  }catch(error){const failure=error instanceof AnalysisFailure?error:new AnalysisFailure('PROVIDER_UNAVAILABLE',true,tokens),observed=failure.tokens??tokens;try{const saved=await db.rpc('worker_fail_analysis',{...args,p_code:failure.code,p_transient:failure.transient,p_tokens:observed,p_uncertain:observed===null});if(!saved.error)state=saved.data.state;}catch{/* Fenced lease recovery retains uncertain provider usage. */}}
  jobs.push({id:job.id,state});
 }
 const metrics=await db.rpc('worker_draft_metrics');if(metrics.error)databaseError(metrics.error);return {enabled:config.enabled,jobs,metrics:metrics.data,duration_ms:Math.max(0,clock()-started)};
}
