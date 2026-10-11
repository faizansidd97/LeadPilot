import {z} from 'zod';
import {assignmentDirectorySchema} from './lead-inbox.ts';
export const websiteMetadataSchema=z.object({id:z.uuid(),name:z.string().trim().min(2).max(120),active:z.boolean(),version:z.number().int().positive().max(2147483647),key_version:z.number().int().positive().max(2147483647),default_assignee_id:z.uuid().nullable(),created_at:z.iso.datetime({offset:true})});
export const websiteListSchema=z.object({integrations:z.array(websiteMetadataSchema).max(20)});
export const websiteDirectorySchema=assignmentDirectorySchema.refine(v=>v.members.length<=10000);
export const signingSecretSchema=z.string().regex(/^[a-f0-9]{64}$/);
export type WebsiteMetadata=z.infer<typeof websiteMetadataSchema>;
export type WebsiteMember=z.infer<typeof assignmentDirectorySchema>['members'][number];
