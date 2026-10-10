import {privacyRequestSchema,privacyActionSchema,type PrivacyCase} from '@leadpilot/backend/domain/privacy';
import type {RequestTicket} from './client-workflow.ts';
import {LeadSaveRecovery} from './lead-workflow.ts';

export class PrivacySaveRecovery extends LeadSaveRecovery {
 constructor(){super(error=>{const e=error as {status?:number;code?:string};return e?.status===403&&e.code==='RECENT_MFA_REQUIRED';});}
}
type Read=(path:string,options:RequestInit,tenant:string,key?:string)=>Promise<any>;
export type LeadChoice={id:string;full_name:string;version:number};
export type ReviewNote={id:string;action:string;case_version:number;reason:string;created_at:string};
export type PrivacyOperation={kind:'request';body:unknown}|{kind:'review';caseId:string;body:unknown};
const uuid=(value:any)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const record=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
const version=(value:any)=>Number.isInteger(value)&&value>0&&value<=2147483647;
const date=(value:any)=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value));
const text=(value:any,max:number,min=0)=>typeof value==='string'&&value.trim().length>=min&&value.length<=max;
const cursor=(value:any)=>value===null||typeof value==='string'&&value.length>0&&value.length<=512;
function invalid(message='Privacy records could not be verified. Refresh to try again.'):never{throw Object.assign(Error(message),{status:503});}
function rows(page:any,key:string,next:any){if(!record(page)||!Array.isArray(page[key])||page[key].length>25||!cursor(next)||page[key].some((row:any)=>!record(row)||!uuid(row.id))||new Set(page[key].map((row:any)=>row.id)).size!==page[key].length)invalid();}
function verifyCase(row:any,tenant:string):PrivacyCase{
 if(!record(row)||!uuid(row.id)||row.tenant_id!==tenant||!['LEAD_ERASURE','AGENCY_CLOSURE'].includes(row.kind)||
  !['REQUESTED','IN_REVIEW','ON_HOLD','WITHDRAWN'].includes(row.state)||!version(row.version)||!text(row.reason,500,5)||
  !date(row.created_at)||!date(row.updated_at)||(row.kind==='LEAD_ERASURE'?!uuid(row.lead_id):row.lead_id!==null)||
  !(row.verification_reference===null||text(row.verification_reference,200,5))||
  (row.state==='ON_HOLD'?!text(row.hold_reason,500,5):row.hold_reason!==null))invalid();
 return {id:row.id,kind:row.kind,lead_id:row.lead_id,state:row.state,reason:row.reason,version:row.version,
  verification_reference:row.verification_reference,hold_reason:row.hold_reason,created_at:row.created_at,updated_at:row.updated_at};
}
export async function loadPrivacyCases(ticket:RequestTicket,read:Read,tenant:string,next:string|null=null){
 ticket.assertCurrent();const page=await read('/api/v1/privacy'+(next?'?cursor='+encodeURIComponent(next):''),{signal:ticket.signal},tenant);ticket.assertCurrent();
 rows(page,'cases',page?.next_cursor);if(page.execution_available!==false)invalid();
 return {cases:page.cases.map((row:any)=>verifyCase(row,tenant)) as PrivacyCase[],next_cursor:page.next_cursor as string|null};
}
export async function loadPrivacyHistory(ticket:RequestTicket,read:Read,tenant:string,caseId:string,next:string|null=null){
 ticket.assertCurrent();if(!uuid(caseId))invalid();const page=await read('/api/v1/privacy/'+caseId+(next?'?cursor='+encodeURIComponent(next):''),{signal:ticket.signal},tenant);ticket.assertCurrent();
 rows(page,'actions',page?.next_cursor);
 if(page.actions.some((row:any)=>!['REVIEW','HOLD','RELEASE_HOLD','WITHDRAW'].includes(row.action)||!version(row.case_version)||row.case_version<2||!text(row.reason,500,5)||!date(row.created_at)))invalid();
 return {actions:page.actions as ReviewNote[],next_cursor:page.next_cursor as string|null};
}
export async function searchPrivacyLeads(ticket:RequestTicket,read:Read,tenant:string,query:string,archived:boolean,next:string|null=null){
 ticket.assertCurrent();const params=new URLSearchParams({q:query,limit:'25',archived:String(archived)});if(next)params.set('cursor',next);
 const page=await read('/api/v1/leads?'+params,{signal:ticket.signal},tenant);ticket.assertCurrent();rows(page,'leads',page?.pagination?.next_cursor);
 if(page.leads.some((row:any)=>row.tenant_id!==tenant||!text(row.full_name,120,1)||!version(row.version)||
  (archived?!date(row.archived_at):row.archived_at!==null)))invalid('Lead choices could not be verified. Search again.');
 return {leads:page.leads.map((row:any)=>({id:row.id,full_name:row.full_name,version:row.version})) as LeadChoice[],next_cursor:page.pagination.next_cursor as string|null};
}
export async function beginPrivacySave(recovery:LeadSaveRecovery,ticket:RequestTicket,read:Read,tenant:string,operation:PrivacyOperation,
 load:(ticket:RequestTicket)=>Promise<void>,complete:()=>void){
 ticket.assertCurrent();const parsed=(operation.kind==='request'?privacyRequestSchema:privacyActionSchema).safeParse(operation.body);
 if(!parsed.success||operation.kind==='review'&&!uuid(operation.caseId))throw Object.assign(Error('Check the privacy request fields before saving.'),{status:422});
 // Parsed values and serialized payload stay bound to this original action during recovery.
 const kind=operation.kind,body=parsed.data,payload=JSON.stringify(body),path='/api/v1/privacy'+(operation.kind==='review'?'/'+operation.caseId:''),method=kind==='request'?'POST':'PATCH';
 const caseId=operation.kind==='review'?operation.caseId:null;
 return recovery.start(ticket,{replayable:true,load,complete,write:async(current,key)=>{
  current.assertCurrent();const receipt=await read(path,{method,body:payload,signal:current.signal},tenant,key);current.assertCurrent();
  const row=verifyCase(receipt,tenant);
  if(kind==='request'){
   const request=privacyRequestSchema.parse(body);if(row.kind!==request.kind||row.lead_id!==request.lead_id||row.version!==1||row.state!=='REQUESTED'||row.reason!==request.reason)invalid('The save response could not be verified. Recover the original save.');
  }else{
   const review=privacyActionSchema.parse(body),state={REVIEW:'IN_REVIEW',HOLD:'ON_HOLD',RELEASE_HOLD:'IN_REVIEW',WITHDRAW:'WITHDRAWN'}[review.action];
   if(row.id!==caseId||row.version!==review.expected_version+1||row.state!==state||
    review.action==='REVIEW'&&row.verification_reference!==review.verification_reference||review.action==='HOLD'&&row.hold_reason!==review.reason)invalid('The review response could not be verified. Recover the original save.');
  }
 }});
}
