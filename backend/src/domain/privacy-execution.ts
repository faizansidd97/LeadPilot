import {z} from 'zod';
const version=z.number().int().positive().max(2147483647);
export const privacyStates=['REQUESTED','IN_REVIEW','ON_HOLD','WITHDRAWN','ANONYMIZING','ANONYMIZED','EXPIRED','CLOSED'] as const;
export const privacyPrepareSchema=z.object({expected_case_version:version,expected_subject_version:version,expected_policy_version:version,confirm:z.literal('ANONYMIZE')}).strict();
export const privacyManifestSchema=z.object({format_version:z.literal(1),job_id:z.uuid(),sequence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),tenant_id:z.uuid(),case_id:z.uuid(),kind:z.enum(['LEAD_ERASURE','AGENCY_CLOSURE']),policy_version:version,prepared_at:z.iso.datetime({offset:true}),lead_ids:z.array(z.uuid()).max(10000)}).strict().superRefine((v,c)=>{
 if(v.kind==='LEAD_ERASURE'&&v.lead_ids.length!==1||new Set(v.lead_ids).size!==v.lead_ids.length||v.lead_ids.some((id,i)=>i>0&&id<=v.lead_ids[i-1]))c.addIssue({code:'custom',message:'Invalid manifest scope.'});
});
export const privacyEnvelopeSchema=z.object({format_version:z.literal(1),key_id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),manifest_text:z.string().min(2).max(1024*1024),signature:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const date=z.iso.datetime({offset:true});const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const privacyStatusSchema=z.object({policy_enabled:z.boolean(),policy_version:version,history_days:z.literal(30),job:z.object({id:z.uuid(),state:z.enum(['PENDING','ANONYMIZED','EXPIRED']),prepared_at:date,completed_at:date.nullable(),history_expires_at:date.nullable(),expired_at:date.nullable(),total:count,processed:count}).strict().nullable(),history:z.object({leads:count,messages:count,tasks:count}).strict().nullable()}).strict().superRefine((s,c)=>{
 if(s.job&&(s.job.processed>s.job.total||s.job.state==='ANONYMIZED'&&(!s.job.completed_at||!s.job.history_expires_at)||s.job.state==='EXPIRED'&&s.history!==null))c.addIssue({code:'custom',message:'Invalid privacy progress.'});
});
export const privacyReceiptSchema=z.object({id:z.uuid(),case_id:z.uuid(),state:z.enum(['PENDING','ANONYMIZED','EXPIRED'])}).strict();
export type PrivacyStatus=z.infer<typeof privacyStatusSchema>;
