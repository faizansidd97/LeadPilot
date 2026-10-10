import { z } from 'zod';
const version=z.number().int().positive();
const reason=z.string().trim().min(5).max(500);
export const controlSchemas={
 assignment:z.object({expected_version:version,assignee_id:z.uuid().nullable(),transfer_open_tasks:z.boolean().default(false),reason}).strict(),
 archive:z.object({expected_version:version,reason,cancel_open_tasks:z.boolean().default(false)}).strict(),
 restore:z.object({expected_version:version,reason}).strict(),
 'contact-preference':z.object({expected_version:version,do_not_contact:z.boolean(),reason}).strict(),
};
export type ControlAction=keyof typeof controlSchemas;
export type AssignmentMember={id:string;role:'OWNER'|'ADMIN'|'AGENT';label:string};
export type ActivityEvent={id:string;actor_id:string|null;event_type:string;reason:string|null;created_at:string;details:Record<string,unknown>};
export type ControlSummary={role:'OWNER'|'ADMIN'|'AGENT';membership_id:string;open_task_count:number;outreach_task_count:number;lead_version:number};
