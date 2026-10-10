import {factsSchema,duplicateSchema} from '../../../backend/src/domain/capture.ts';
import type {RequestTicket} from './client-workflow.ts';
import {LeadSaveRecovery,LeadWorkflowError} from './lead-workflow.ts';

type Read=(path:string,options:RequestInit,tenant:string,key?:string)=>Promise<any>;
export type FactsOperation={kind:'facts'|'duplicates';input:unknown};
export type DuplicateCandidate={id:string;full_name:string;email:string|null;phone:string|null;status:string;archived_at:string|null};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
const version=(value:any)=>Number.isSafeInteger(value)&&value>0;
const statuses=['NEW','CONTACTED','QUALIFIED','FOLLOW_UP','WON','LOST'];
const date=(value:any)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const text=(value:any,max:number)=>typeof value==='string'&&value.length<=max;
function invalid():never{throw new LeadWorkflowError('Lead facts could not be verified. Retry loading the latest details.');}

export function verifyFactsLead(row:any,tenant:string,id:string,minVersion=1):Record<string,unknown>{
 if(!record(row)||row.tenant_id!==tenant||row.id!==id||!version(row.version)||row.version<minVersion||
  !text(row.full_name,120)||!row.full_name.trim()||!statuses.includes(row.status)||
  !['MANUAL','CSV','WEBSITE'].includes(row.source)||typeof row.duplicate_review!=='boolean'||
  !(row.archived_at===null||date(row.archived_at))||!Array.isArray(row.locations)||!text(row.notes,2000))invalid();
 for(const [key,max] of [['email',254],['phone',20],['qualification_summary',1000],['outcome_summary',1000],['lost_reason',120]] as const)
  if(Object.hasOwn(row,key)&&!(row[key]===null||text(row[key],max)))invalid();
 for(const key of ['created_at','won_at'])if(Object.hasOwn(row,key)&&!(row[key]===null||date(row[key])))invalid();
 for(const key of ['budget_min','budget_max'])if(Object.hasOwn(row,key)&&!(row[key]===null||typeof row[key]==='number'&&Number.isFinite(row[key])&&row[key]>=0))invalid();
 if(Object.hasOwn(row,'do_not_contact')&&typeof row.do_not_contact!=='boolean'||
  Object.hasOwn(row,'assignee_id')&&!(row.assignee_id===null||uuid(row.assignee_id))||
  Object.hasOwn(row,'currency')&&!(row.currency===null||['AED','USD','EUR','GBP','SAR'].includes(row.currency))||
  Object.hasOwn(row,'reported_facts')&&!record(row.reported_facts)||
  Object.hasOwn(row,'current_analysis')&&row.current_analysis!==undefined&&!record(row.current_analysis))invalid();
 const fields=['confirmed_intent','budget_period','locations','property_type','bedrooms','purchase_timeline','source_reference','notes'];
 const facts=Object.fromEntries(fields.map(key=>[key,row[key]]));
 if(!factsSchema.safeParse({...facts,expected_version:row.version}).success)invalid();
 // Only properties consumed by toLead can reach the mounted workspace.
 const keys=['created_at','current_analysis','id','tenant_id','full_name','email','phone','status','source','version','do_not_contact',
  'budget_min','budget_max','qualification_summary','outcome_summary','won_at','lost_reason','archived_at','assignee_id','currency','reported_facts','duplicate_review',...fields];
 return Object.fromEntries(keys.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]));
}

export async function loadFactsLead(ticket:RequestTicket,read:Read,tenant:string,id:string,minVersion=1){
 ticket.assertCurrent();const row=await read(`/api/v1/leads/${id}`,{signal:ticket.signal},tenant);ticket.assertCurrent();
 return verifyFactsLead(row,tenant,id,minVersion);
}

export async function loadDuplicatePage(ticket:RequestTicket,read:Read,tenant:string,id:string,role:string,after:string|null=null){
 ticket.assertCurrent();
 if(!['OWNER','ADMIN'].includes(role))throw new LeadWorkflowError('Duplicate identities are restricted to managers.',403);
 if(after!==null&&!uuid(after))invalid();
 const page=await read(`/api/v1/leads/${id}/duplicates`+(after?'?cursor='+encodeURIComponent(after):''),{signal:ticket.signal},tenant);
 ticket.assertCurrent();
 if(page?.restricted===true)throw new LeadWorkflowError('Your access changed. Reopen the workspace.',403);
 if(!record(page)||page.restricted!==false||typeof page.review_required!=='boolean'||!Array.isArray(page.candidates)||page.candidates.length>25||
  !(page.next_cursor===null||uuid(page.next_cursor)))invalid();
 const candidates:DuplicateCandidate[]=page.candidates.map((row:any)=>{
  if(!record(row)||!uuid(row.id)||row.id===id||!text(row.full_name,120)||!row.full_name.trim()||!statuses.includes(row.status)||
   !(row.email===null||text(row.email,254))||!(row.phone===null||text(row.phone,20))||
   !(row.archived_at===null||date(row.archived_at)))invalid();
  return {id:row.id,full_name:row.full_name,email:row.email,phone:row.phone,status:row.status,archived_at:row.archived_at};
 });
 let previous=after?.toLowerCase()??'';
 for(const row of candidates){if(row.id.toLowerCase()<=previous)invalid();previous=row.id.toLowerCase();}
 if(page.next_cursor!==null&&(candidates.length!==25||page.next_cursor!==candidates.at(-1)?.id))invalid();
 return {candidates,next_cursor:page.next_cursor as string|null,review_required:page.review_required as boolean};
}

export async function beginFactsSave(recovery:LeadSaveRecovery,ticket:RequestTicket,read:Read,tenant:string,id:string,
 operation:FactsOperation,publish:(row:Record<string,unknown>)=>void,complete:()=>void){
 ticket.assertCurrent();
 if(!uuid(tenant)||!uuid(id)||!['facts','duplicates'].includes(operation.kind))throw new LeadWorkflowError('Check the lead and supplied fields.',422);
 const parsed=(operation.kind==='facts'?factsSchema:duplicateSchema).safeParse(operation.input);
 if(!parsed.success)throw new LeadWorkflowError('Check the supplied facts or review reason.',422);
 // Parse and serialize before awaiting. Later edits cannot replace this save's version, input or key.
 const body=JSON.stringify(parsed.data),kind=operation.kind,expectedVersion=parsed.data.expected_version;
 return recovery.start(ticket,{replayable:true,
  write:async(current,key)=>{
   const data=await read(`/api/v1/leads/${id}/${kind}`,{method:kind==='facts'?'PATCH':'POST',body,signal:current.signal},tenant,key);
   current.assertCurrent();const row=verifyFactsLead(data,tenant,id,expectedVersion+1);
   if(row.version!==expectedVersion+1||kind==='duplicates'&&row.duplicate_review!==false)invalid();
  },
  load:async current=>{const row=await loadFactsLead(current,read,tenant,id,expectedVersion+1);current.assertCurrent();publish(row);},
  complete,
 });
}
