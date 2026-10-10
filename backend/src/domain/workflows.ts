import { z } from 'zod';
import { statuses } from './leads.ts';
export const taskTypes=['CALL','MESSAGE','EMAIL','VIEWING','INTERNAL'] as const;
export type TaskType=typeof taskTypes[number];
export type FollowUp={id:string;lead_id:string;assignee_id:string|null;type:TaskType;title:string;notes:string;due_at:string;state:'OPEN'|'COMPLETED'|'CANCELLED';version:number;schedule_version:number;completion_summary?:string|null;cancel_reason?:string|null;leads?:{id:string;full_name:string}};
export type ConversationMessage={id:string;direction:'INBOUND'|'OUTBOUND'|'INTERNAL';body:string;occurred_at:string;created_at:string;delivery_status?:'USER_REPORTED'|null;channel?:'MANUAL'|'WEBSITE';version?:number;source_reference?:string|null;ingested_at?:string|null;revisions?:{previous_body:string;reason:string;actor_id:string;created_at:string;revision:number}[]};
const version=z.number().int().positive();
const future=z.iso.datetime({offset:true}).refine(value=>Date.parse(value)>Date.now(),'Choose a future due time.');
export const createFollowUpSchema=z.object({lead_id:z.uuid(),assignee_id:z.uuid().optional(),type:z.enum(taskTypes),title:z.string().trim().min(1).max(150),notes:z.string().trim().max(2000).default(''),due_at:future,expected_lead_version:version}).strict();
export const taskActionSchemas={
 complete:z.object({expected_version:version,summary:z.string().trim().min(1).max(2000)}).strict(),
 reschedule:z.object({expected_version:version,due_at:future,reason:z.string().trim().min(5).max(500)}).strict(),
 cancel:z.object({expected_version:version,reason:z.string().trim().min(5).max(500)}).strict(),
};
export const statusChangeSchema=z.object({
 status:z.enum(statuses),expected_version:version,reason:z.string().trim().min(5).max(500).optional(),cancel_open_tasks:z.boolean().default(false),
 confirmed_intent:z.enum(['BUY','RENT','SELL','INVEST','OTHER']).optional(),qualification_summary:z.string().trim().min(5).max(1000).optional(),
 acknowledge_unknowns:z.boolean().default(false),locations:z.array(z.string().trim().min(1).max(120)).max(5).optional(),
 won_at:z.iso.datetime({offset:true}).optional(),outcome_summary:z.string().trim().min(5).max(1000).optional(),
 deal_value:z.number().finite().nonnegative().optional(),deal_currency:z.enum(['AED','USD','EUR','GBP','SAR']).optional(),
 lost_reason:z.enum(['NO_RESPONSE','NOT_INTERESTED','BUDGET_MISMATCH','ALREADY_CLOSED','DUPLICATE','OTHER']).optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.status==='QUALIFIED'&&(!value.confirmed_intent||!value.qualification_summary))ctx.addIssue({code:'custom',path:['qualification_summary'],message:'Confirm intent and qualification needs.'});
 if(value.status==='WON'&&(!value.won_at||Date.parse(value.won_at)>Date.now()||!value.outcome_summary))ctx.addIssue({code:'custom',path:['won_at'],message:'Provide an outcome summary and a past or current outcome time.'});
 if(value.deal_value!==undefined&&!value.deal_currency)ctx.addIssue({code:'custom',path:['deal_currency'],message:'Deal value requires an explicit currency.'});
 if(value.status==='LOST'&&(!value.lost_reason||(value.lost_reason==='OTHER'&&!value.reason)))ctx.addIssue({code:'custom',path:['lost_reason'],message:'Choose a loss reason and explain OTHER.'});
});

export function zonedInputToIso(input:string,timeZone:string):string {
 const match=input.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
 if(!match)throw new Error('Enter a complete local date and time.');
 const [year,month,day,hour,minute]=match.slice(1).map(Number);
 const wall=Date.UTC(year,month-1,day,hour,minute);
 const parsed=new Date(wall);
 if(year<1970||parsed.getUTCFullYear()!==year||parsed.getUTCMonth()!==month-1||parsed.getUTCDate()!==day||hour>23||minute>59)throw new Error('Enter a valid date and time.');
 const format=new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const parts=(stamp:number)=>Object.fromEntries(format.formatToParts(new Date(stamp)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
 const offsets=new Set<number>();
 for(const shift of [-86400000,0,86400000]){const probe=wall+shift;const p=parts(probe);offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)-probe);}
 const candidates=[...offsets].map(offset=>wall-offset).filter(stamp=>{const p=parts(stamp);return p.year===year&&p.month===month&&p.day===day&&p.hour===hour&&p.minute===minute;});
 if(candidates.length!==1)throw new Error(candidates.length?'This time occurs twice during a clock change. Choose an unambiguous time.':'This local time does not exist during a clock change.');
 return new Date(candidates[0]).toISOString();
}
export function formatAgencyDate(value:string,timeZone:string){return new Intl.DateTimeFormat('en-GB',{timeZone,dateStyle:'medium',timeStyle:'short'}).format(new Date(value));}
