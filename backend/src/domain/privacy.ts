import {z} from 'zod';
export const privacyRequestSchema=z.object({kind:z.enum(['LEAD_ERASURE','AGENCY_CLOSURE']),lead_id:z.uuid().nullable().default(null),expected_version:z.number().int().positive().max(2147483647),reason:z.string().trim().min(5).max(500)}).strict().superRefine((v,c)=>{if((v.kind==='LEAD_ERASURE')!==(v.lead_id!==null))c.addIssue({code:'custom',path:['lead_id'],message:'Choose a lead for erasure, or agency scope for closure.'});});
export const privacyActionSchema=z.object({action:z.enum(['REVIEW','HOLD','RELEASE_HOLD','WITHDRAW']),expected_version:z.number().int().positive().max(2147483647),reason:z.string().trim().min(5).max(500),verification_reference:z.string().trim().min(5).max(200).optional()}).strict().superRefine((v,c)=>{if(v.action==='REVIEW'&&(v.verification_reference?.length??0)<5)c.addIssue({code:'custom',path:['verification_reference'],message:'Record the external identity-verification reference.'});});

export type PrivacyCase={id:string;kind:"LEAD_ERASURE"|"AGENCY_CLOSURE";lead_id:string|null;state:"REQUESTED"|"IN_REVIEW"|"ON_HOLD"|"WITHDRAWN";reason:string;version:number;verification_reference:string|null;hold_reason:string|null;created_at:string;updated_at:string};

const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const privacyImpactQuerySchema=z.object({expected_version:z.coerce.number().int().positive().max(2147483647)}).strict();
export const privacyImpactSchema=z.object({tenant_id:z.uuid(),case_id:z.uuid(),case_version:z.number().int().positive().max(2147483647),
 case_state:z.enum(['REQUESTED','IN_REVIEW','ON_HOLD','WITHDRAWN']),kind:z.enum(['LEAD_ERASURE','AGENCY_CLOSURE']),lead_id:z.uuid().nullable(),
 subject_version:z.number().int().positive().max(2147483647),as_of:z.iso.datetime({offset:true}),identity_verification_recorded:z.boolean(),
 intersecting_holds:count,open_tasks:count,active_ai_jobs:count,reconcile_ai_jobs:count,
 retention_policy_approved:z.literal(false),inventory_complete:z.literal(false),execution_available:z.literal(false),
 counts:z.object({leads:count,messages:count,message_revisions:count,follow_ups:count,activity_events:count,ai_jobs:count,
  ai_analyses:count,reply_drafts:count,draft_feedback:count,notifications:count,privacy_cases:count,privacy_case_actions:count}).strict()
}).strict().superRefine((v,c)=>{
 if((v.kind==='LEAD_ERASURE')!==(v.lead_id!==null)||v.kind==='LEAD_ERASURE'&&v.counts.leads!==1||v.counts.privacy_cases<1||
  v.open_tasks>v.counts.follow_ups||v.active_ai_jobs>v.counts.ai_jobs||v.reconcile_ai_jobs>v.counts.ai_jobs||
  v.case_state==='ON_HOLD'&&v.intersecting_holds<1)c.addIssue({code:'custom',message:'Privacy snapshot is inconsistent.'});
});
export type PrivacyImpact=z.infer<typeof privacyImpactSchema>;
