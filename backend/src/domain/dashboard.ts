import {z} from 'zod';
import {statuses} from './leads.ts';
export const dashboardMetrics=['TOTAL','QUALIFIED','WON','UNASSIGNED','DUE','CONTACTED_IN_COHORT','STAGE_NEW','STAGE_CONTACTED','STAGE_QUALIFIED','STAGE_FOLLOW_UP','STAGE_WON','STAGE_LOST'] as const;
export type DashboardMetric=typeof dashboardMetrics[number];
const date=z.iso.date().refine(v=>Number(v.slice(0,4))>=1970&&Number(v.slice(0,4))<=9998,'Choose a supported date.');
export const dashboardQuerySchema=z.object({from:date.optional(),to:date.optional(),metric:z.enum(dashboardMetrics).optional(),as_of:z.iso.datetime({offset:true}).optional(),cursor:z.string().max(1024).optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict().superRefine((v,c)=>{
 if(!!v.from!==!!v.to)c.addIssue({code:'custom',message:'Choose both dates.'});
 if(v.from&&v.to&&(v.from>v.to||(Date.parse(v.to)-Date.parse(v.from))/86400000>365))c.addIssue({code:'custom',message:'Choose an ordered range of at most 366 calendar days.'});
 if(!v.metric&&(v.cursor||v.as_of))c.addIssue({code:'custom',message:'Snapshot and cursor belong to a metric list.'});
 if(v.metric&&(!v.from||!v.to||!v.as_of))c.addIssue({code:'custom',message:'Use the displayed metric dates and snapshot.'});
});
export const dashboardCursorSchema=z.object({tenant_id:z.uuid(),actor_id:z.uuid(),sort_at:z.iso.datetime({offset:true}),id:z.uuid(),metric:z.enum(dashboardMetrics),from:date,to:date,as_of:z.iso.datetime({offset:true})}).strict();
export function dashboardCursorValue(row:{row_id:string;sort_at:string},binding:{tenant_id:string;actor_id:string;metric:string;from:string;to:string;as_of:string}){return dashboardCursorSchema.parse({...binding,id:row.row_id,sort_at:row.sort_at});}
const stamp=z.iso.datetime({offset:true}),count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const dashboardSummarySchema=z.object({
 window:z.object({from:date,to:date,timezone:z.string().min(1).max(100),start_at:stamp,end_at:stamp,as_of:stamp,scope:z.enum(['AGENCY','CURRENT_ASSIGNED']),manager:z.boolean()}),
 metrics:z.object({total:count,qualified:count,won:count,due:count,unassigned:count.nullable()}),
 pipeline:z.object({NEW:count,CONTACTED:count,QUALIFIED:count,FOLLOW_UP:count,WON:count,LOST:count}).strict(),
 contact:z.object({sample_count:count,without_logged_contact:count,median_seconds:z.number().finite().nonnegative().nullable()}),
}).refine(s=>s.window.from<=s.window.to&&Date.parse(s.window.end_at)>Date.parse(s.window.start_at)&&
 s.metrics.total===Object.values(s.pipeline).reduce((sum,n)=>sum+n,0)&&s.metrics.qualified===s.pipeline.QUALIFIED&&
 s.contact.sample_count+s.contact.without_logged_contact===s.metrics.total&&((s.contact.sample_count===0)===(s.contact.median_seconds===null))&&
 (s.window.manager?s.window.scope==='AGENCY'&&s.metrics.unassigned!==null:s.window.scope==='CURRENT_ASSIGNED'&&s.metrics.unassigned===null),'Invalid dashboard summary.');
const leadPayload=z.object({id:z.uuid(),tenant_id:z.uuid(),full_name:z.string().min(1).max(120).refine(v=>!!v.trim()),status:z.enum(statuses),assignee_id:z.uuid().nullable(),archived_at:z.null(),created_at:stamp,won_at:stamp.nullable(),version:z.number().int().positive(),first_logged_contact_at:stamp.optional(),contact_latency_seconds:z.number().finite().nonnegative().optional()});
const taskPayload=z.object({id:z.uuid(),tenant_id:z.uuid(),lead_id:z.uuid(),title:z.string().min(1).max(150).refine(v=>!!v.trim()),state:z.literal('OPEN'),due_at:stamp,assignee_id:z.uuid().nullable(),lead_name:z.string().min(1).max(120).refine(v=>!!v.trim()),lead_status:z.enum(statuses),version:z.number().int().positive()});
export const dashboardItemSchema=z.discriminatedUnion('entity',[
 z.object({row_id:z.uuid(),sort_at:stamp,entity:z.literal('LEAD'),payload:leadPayload}),
 z.object({row_id:z.uuid(),sort_at:stamp,entity:z.literal('TASK'),payload:taskPayload}),
]);
export const dashboardPageSchema=z.object({items:z.array(dashboardItemSchema).max(25),pagination:z.object({next_cursor:z.string().min(1).max(1024).nullable()})});
export type DashboardSummary=z.infer<typeof dashboardSummarySchema>;
export type DashboardItem=z.infer<typeof dashboardItemSchema>;
export function bindDashboardCursor(value:unknown,expected:{tenant_id:string;actor_id:string;metric:string;from:string;to:string;as_of:string}){
 const cursor=dashboardCursorSchema.parse(value);
 for(const key of ['tenant_id','actor_id','metric','from','to','as_of'] as const)if(cursor[key]!==expected[key])throw new Error('INVALID_CURSOR');
 return cursor;
}
export function defaultDashboardDates(timezone:string,now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(v=>v.type!=='literal').map(v=>[v.type,v.value]));
 const to=`${p.year}-${p.month}-${p.day}`,start=new Date(to+'T12:00:00Z');start.setUTCDate(start.getUTCDate()-29);return {from:start.toISOString().slice(0,10),to};
}
