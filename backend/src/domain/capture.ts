import {z} from 'zod';
import {createLeadSchema} from './leads.ts';
export const factFields={
 confirmed_intent:z.enum(['BUY','RENT','SELL','INVEST','OTHER']).nullable().default(null),
 budget_period:z.enum(['MONTH','YEAR','TOTAL','UNKNOWN']).default('UNKNOWN'),
 locations:z.array(z.string().trim().min(1).max(120)).max(5).transform(v=>[...new Set(v)]).default([]),
 property_type:z.string().trim().max(120).nullable().default(null),
 bedrooms:z.number().int().min(0).max(50).nullable().default(null),
 purchase_timeline:z.string().trim().max(500).nullable().default(null),
 source_reference:z.string().trim().max(500).nullable().default(null),
 notes:z.string().trim().max(2000).default(''),
};
export const captureLeadSchema=createLeadSchema.safeExtend(factFields);
export const factsSchema=z.object({
 confirmed_intent:factFields.confirmed_intent.removeDefault().optional(),budget_period:factFields.budget_period.removeDefault().optional(),locations:factFields.locations.removeDefault().optional(),
 property_type:factFields.property_type.removeDefault().optional(),bedrooms:factFields.bedrooms.removeDefault().optional(),purchase_timeline:factFields.purchase_timeline.removeDefault().optional(),
 source_reference:factFields.source_reference.removeDefault().optional(),notes:factFields.notes.removeDefault().optional(),expected_version:z.number().int().positive(),
}).strict().refine(v=>Object.keys(v).length>1,'Provide at least one confirmed field.');
export const duplicateSchema=z.object({expected_version:z.number().int().positive(),reason:z.string().trim().min(5).max(500)}).strict();
export const revisionSchema=z.object({body:z.string().trim().min(1).max(10000),reason:z.string().trim().min(5).max(500),expected_version:z.number().int().positive(),expected_lead_version:z.number().int().positive()}).strict();
export const integrationSchema=z.object({name:z.string().trim().min(2).max(120),default_assignee_id:z.uuid().nullable().default(null)}).strict();
export const integrationChangeSchema=z.object({action:z.enum(['rotate','revoke']),expected_version:z.number().int().positive(),reason:z.string().trim().min(5).max(500)}).strict();
export const intakeSchema=z.object({external_event_id:z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),lead:captureLeadSchema,occurred_at:z.iso.datetime({offset:true}).optional()}).strict().refine(v=>!v.occurred_at||Date.parse(v.occurred_at)<=Date.now(),{path:['occurred_at'],message:'Customer message time cannot be in the future.'});
export type CaptureLead=z.infer<typeof captureLeadSchema>;
export const csvColumns=[...Object.keys(createLeadSchema.shape),...Object.keys(factFields),'assignee_email'] as const;
export const importConfirmSchema=z.object({create_separate:z.boolean().default(false),reason:z.string().trim().max(500).default('')}).strict().refine(v=>!v.create_separate||v.reason.length>=5,{path:['reason'],message:'Explain why duplicate contacts should create separate leads.'});
export type ImportRow={row_index:number;payload?:Record<string,unknown>;errors?:Record<string,string>};
