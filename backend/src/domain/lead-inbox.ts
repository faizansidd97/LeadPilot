import {z} from 'zod';
import {statuses} from './leads.ts';
import {captureLeadSchema} from './capture.ts';
export const inboxFilterSchema=z.object({q:z.string().max(120),status:z.enum(['ALL',...statuses]),archived:z.boolean()}).strict();
export type InboxFilter=z.infer<typeof inboxFilterSchema>;
const stamp=z.iso.datetime({offset:true});
export const leadCursorSchema=z.object({created_at:stamp,id:z.uuid()}).strict();
export function leadCursorValue(row:{created_at:unknown;id:unknown}){return leadCursorSchema.parse({created_at:row.created_at,id:row.id});}
export const inboxScoreSchema=z.object({id:z.uuid(),score:z.number().int().min(0).max(100),temperature:z.enum(['HOT','WARM','COLD']),rubric_version:z.string().min(1).max(120),score_as_of:stamp});
export const inboxRowSchema=z.object({id:z.uuid(),tenant_id:z.uuid(),version:z.number().int().positive(),created_at:stamp,archived_at:stamp.nullable(),full_name:z.string().min(1).max(120).refine(v=>!!v.trim()),email:z.string().max(254).nullable(),phone:z.string().max(20).nullable(),status:z.enum(statuses),source:z.enum(['MANUAL','CSV','WEBSITE']),locations:z.array(z.string().min(1).max(120)).max(5),assignee_id:z.uuid().nullable(),current_analysis:inboxScoreSchema.optional()});
export const inboxPageSchema=z.object({leads:z.array(inboxRowSchema).max(25),pagination:z.object({next_cursor:z.string().min(1).max(512).nullable()})});
export const manualLeadSchema=captureLeadSchema.safeExtend({assignee_id:z.uuid().nullable().optional()});
export const assignmentDirectorySchema=z.object({members:z.array(z.object({id:z.uuid(),label:z.string().min(1).max(254),role:z.enum(['OWNER','ADMIN','AGENT'])})).refine(rows=>new Set(rows.map(r=>r.id.toLowerCase())).size===rows.length)});
export type InboxRow=z.infer<typeof inboxRowSchema>;
