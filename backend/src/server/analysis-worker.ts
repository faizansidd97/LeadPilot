import {AnalysisFailure,validateAnalysis} from '../domain/analysis.ts';
import {preparedProviderRequestId} from '../domain/ai-attempts.ts';
import {requestAnalysis,type AnalysisConfig} from './analysis-provider.ts';
import {databaseError} from './http.ts';
import type {WorkerDb} from './notification-worker.ts';
export async function runAnalyses(db:WorkerDb,config:AnalysisConfig,provider=requestAnalysis,clock=Date.now){
 const start=clock(),requestId=crypto.randomUUID(),jobs:{id:string;state:string}[]=[];
 const policy=await db.rpc('worker_set_ai_policy',{p_enabled:config.enabled,p_model:config.model,p_languages:config.languages,p_rubric_approved:config.enabled,p_request_id:requestId});if(policy.error)databaseError(policy.error);
 for(let count=0;count<3&&clock()-start<35000;count++){
  const claim=await db.rpc('worker_claim_analysis',{p_request_id:requestId});if(claim.error)databaseError(claim.error);if(!claim.data)break;
  const job=claim.data,args={p_job:job.id,p_lease:job.lease_token,p_request_id:requestId};let tokens:number|null=0,state='LEASE_RECOVERY_PENDING';
  try{
   const context=await db.rpc('worker_prepare_analysis',args);if(context.error)throw new AnalysisFailure('TRANSIENT_DATABASE_FAILURE',true,0);
   if(!context.data){jobs.push({id:job.id,state:'CANCELLED'});continue;}
   const providerRequestId=preparedProviderRequestId(context.data);
   tokens=null;const sentAt=clock(),response=await provider(context.data.snapshot,{...config,model:context.data.model},providerRequestId);tokens=response.tokens;
   const result=validateAnalysis(response.analysis,context.data.snapshot,context.data.languages,clock());
   const saved=await db.rpc('worker_finish_analysis',{...args,p_result:result,p_tokens:tokens,p_latency:Math.min(90000,Math.max(0,clock()-sentAt))});if(saved.error)throw new AnalysisFailure('TRANSIENT_DATABASE_FAILURE',true,tokens);state=saved.data.state;
  }catch(error){const failure=error instanceof AnalysisFailure?error:new AnalysisFailure('PROVIDER_UNAVAILABLE',true,tokens);const observed=failure.tokens??tokens;
   try{const saved=await db.rpc('worker_fail_analysis',{...args,p_code:failure.code,p_transient:failure.transient,p_tokens:observed,p_uncertain:observed===null});if(!saved.error)state=saved.data.state;}catch{/* Expiring fenced lease preserves uncertain usage for reconciliation. */}
  }
  jobs.push({id:job.id,state});
 }
 const metrics=await db.rpc('worker_analysis_metrics');if(metrics.error)databaseError(metrics.error);return {enabled:config.enabled,jobs,metrics:metrics.data,duration_ms:Math.max(0,clock()-start)};
}
