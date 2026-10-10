import {z} from 'zod';
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
export function bindDashboardCursor(value:unknown,expected:{tenant_id:string;actor_id:string;metric:string;from:string;to:string;as_of:string}){
 const cursor=dashboardCursorSchema.parse(value);
 for(const key of ['tenant_id','actor_id','metric','from','to','as_of'] as const)if(cursor[key]!==expected[key])throw new Error('INVALID_CURSOR');
 return cursor;
}
export function defaultDashboardDates(timezone:string,now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).filter(v=>v.type!=='literal').map(v=>[v.type,v.value]));
 const to=`${p.year}-${p.month}-${p.day}`,start=new Date(to+'T12:00:00Z');start.setUTCDate(start.getUTCDate()-29);return {from:start.toISOString().slice(0,10),to};
}
