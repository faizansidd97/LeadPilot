import {z} from 'zod';
import {AnalysisFailure} from './analysis.ts';
export function preparedProviderRequestId(context:{provider_request_id?:unknown}):string {
 const parsed=z.uuid().safeParse(context.provider_request_id);
 if(!parsed.success)throw new AnalysisFailure('TRANSIENT_DATABASE_FAILURE',true,0);
 return parsed.data;
}
const tokens=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const aiAttemptDiagnosticsSchema=z.object({
 job_id:z.uuid(),kind:z.enum(['ANALYSIS','DRAFT']),job_version:z.number().int().positive().max(2147483647),
 state:z.enum(['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED']),usage_state:z.enum(['RESERVED','CONSUMED','RELEASED','RECONCILE']),
 uncertain_usage:z.boolean(),observed_tokens:tokens,reserved_tokens:tokens,
 claim_attempts:z.number().int().min(0).max(3),claims_without_prepare_record:z.number().int().min(0).max(3),
 attempts:z.array(z.object({claim_attempt:z.number().int().min(1).max(3),provider_request_id:z.uuid(),prepared_at:z.iso.datetime({offset:true})}).strict()).max(3),
 provider_usage_verified:z.literal(false),resolution_available:z.literal(false),
}).strict().superRefine((v,c)=>{
 if(v.attempts.length+v.claims_without_prepare_record!==v.claim_attempts||
    v.attempts.some((a,i)=>a.claim_attempt>v.claim_attempts||(i>0&&a.claim_attempt<=v.attempts[i-1].claim_attempt))||
    new Set(v.attempts.map(a=>a.provider_request_id)).size!==v.attempts.length)c.addIssue({code:'custom',message:'Inconsistent attempt history.'});
});
