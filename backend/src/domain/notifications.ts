import {z} from 'zod';
export const notificationSchema=z.object({expected_version:z.number().int().positive(),read:z.literal(true).optional(),dismiss:z.literal(true).optional()}).strict().refine(value=>value.read||value.dismiss,'Choose read or dismiss.');
export const notificationListSchema=z.object({filter:z.enum(['ALL','UNREAD','DISMISSED']).default('ALL'),limit:z.coerce.number().int().min(1).max(100).default(25),cursor:z.string().max(512).optional()}).strict();
export const notificationLabels:Record<string,string>={LEAD_ASSIGNED:'Lead assignment',FOLLOW_UP_DUE:'Follow up due',AI_READY:'Analysis ready',AI_FAILED:'Analysis needs attention',INVITE_ACCEPTED:'Invitation accepted',MANAGER_REVIEW:'Manager review needed'};
export type NotificationRow={id:string;type:string;created_at:string;read_at:string|null;dismissed_at:string|null;version:number;current:boolean;can_open:boolean;resource_label:string|null;due_at:string|null};
