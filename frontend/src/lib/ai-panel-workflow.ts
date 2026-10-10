import {z,version,stamp,draftSchema,analysisPage,draftPage} from '../../../backend/src/domain/ai-client-contracts.ts';
import {ClientRequests,type RequestTicket} from './client-workflow.ts';
import {LeadSaveRecovery,LeadWorkflowError} from './lead-workflow.ts';

export type AnalysisHistory=z.infer<typeof analysisPage>;
export type DraftHistory=z.infer<typeof draftPage>;
export type AiHistory=AnalysisHistory|DraftHistory;
export type Draft=z.infer<typeof draftSchema>;
export type AiBoundary={canStart?:()=>boolean;onStateChange?:(state:{busy:boolean;pending:boolean})=>void;onAccessDenied?:(error:unknown)=>void};
function invalid():never{throw new LeadWorkflowError('AI history or save acknowledgement could not be verified. Recover or refresh before continuing.');}
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)invalid();return result.data;}
function before(a:{requested_at:string;id:string},b:{requested_at:string;id:string}){return Date.parse(a.requested_at)>Date.parse(b.requested_at)||a.requested_at===b.requested_at&&a.id>b.id;}
export function validateAiHistory(kind:'analyses'|'drafts',value:unknown,tenant:string,lead:string):AiHistory{
 const page:AiHistory=kind==='analyses'?parse(analysisPage,value):parse(draftPage,value);
 if(page.lead.id!==lead||new Set(page.jobs.map(j=>j.id)).size!==page.jobs.length||page.jobs.some((j,i)=>i>0&&!before(page.jobs[i-1],j)))invalid();
 if(page.next_cursor){try{const cursor=JSON.parse(atob(page.next_cursor.replaceAll('-','+').replaceAll('_','/'))),last=page.jobs.at(-1);if(!last||cursor.id!==last.id||cursor.created_at!==last.requested_at||Object.keys(cursor).length!==2)invalid();}catch{invalid();}}
 const rows='drafts' in page?page.drafts:page.analyses;
 if(new Set(rows.map(r=>r.id)).size!==rows.length||new Set(rows.map(r=>r.job_id)).size!==rows.length)invalid();
 for(const row of rows){const job=page.jobs.find(j=>j.id===row.job_id);if(row.tenant_id!==tenant||row.lead_id!==lead||!job||job.state!=='SUCCEEDED'||job.input_version!==row.input_version)invalid();
  const current=row.input_version===page.lead.context_version&&('drafts' in page?('state' in row&&row.state!=='SUPERSEDED'):('current_analysis_id' in page.lead&&page.lead.current_analysis_id===row.id));
  if(row.freshness!==(current?'CURRENT':'STALE'))invalid();
 }
 return page;
}
export function mergeAiHistory<T extends AiHistory>(previous:T,next:T):T{
 if(previous.lead.id!==next.lead.id||previous.lead.version!==next.lead.version||previous.lead.context_version!==next.lead.context_version||previous.enabled!==next.enabled||('drafts' in previous&&'drafts' in next&&previous.outreach_allowed!==next.outreach_allowed)||('analyses' in previous&&'analyses' in next&&previous.lead.current_analysis_id!==next.lead.current_analysis_id))throw new LeadWorkflowError('Lead context changed while paging. Refresh history before continuing.');
 if(next.jobs.some(j=>previous.jobs.some(old=>old.id===j.id))||previous.jobs.length&&next.jobs.length&&!before(previous.jobs.at(-1)!,next.jobs[0]))invalid();
 return {...next,jobs:[...previous.jobs,...next.jobs],...('drafts' in previous&&'drafts' in next?{drafts:[...previous.drafts,...next.drafts]}:'analyses' in previous&&'analyses' in next?{analyses:[...previous.analyses,...next.analyses]}:{})} as T;
}
export type Receipt={jobId?:string;jobVersion?:number;cancelled?:boolean;draft?:Draft;leadVersion?:number};
export function validateAiReceipt(value:any,path:string,payload:any,tenant:string,lead:string):Receipt{
 if(path.endsWith('/analyze')||path.endsWith('/generate')){const job=parse(z.object({job_id:z.uuid(),state:z.enum(['QUEUED','RUNNING']),reused:z.boolean()}),value);return {jobId:job.job_id};}
 if(path.endsWith('/cancel')){parse(z.object({state:z.literal('CANCELLED'),usage_state:z.enum(['RELEASED','RECONCILE','CONSUMED','RESERVED'])}),value);return {jobId:path.split('/').at(-2),jobVersion:payload.expected_version+1,cancelled:true};}
 const id=path.split('/')[4];
 if(path.endsWith('/external-message')){
  const result=parse(z.object({draft_id:z.uuid(),message:z.object({lead_version:version,context_version:version,delivery_status:z.literal('USER_REPORTED'),message:z.object({id:z.uuid(),tenant_id:z.uuid(),lead_id:z.uuid(),version,direction:z.literal('OUTBOUND'),body:z.string(),occurred_at:stamp,delivery_status:z.literal('USER_REPORTED')})})}),value),message=result.message.message;
  if(result.draft_id!==id||message.tenant_id!==tenant||message.lead_id!==lead||message.body!==payload.body||Date.parse(message.occurred_at)!==Date.parse(payload.occurred_at)||result.message.lead_version!==payload.expected_lead_version+1)invalid();
  return {leadVersion:result.message.lead_version};
 }
 if(path.endsWith('/feedback'))parse(z.object({feedback_id:z.uuid()}),value);
 if(path.endsWith('/copied')&&value?.copied!==true)invalid();
 const draft=parse(draftSchema,value?.draft??value),expected=payload.expected_version+(path.endsWith('/feedback')&&payload.category!=='UNSAFE'?0:1);
 if(draft.id!==id||draft.tenant_id!==tenant||draft.lead_id!==lead||draft.version!==expected||path.endsWith('/edit')&&draft.working_text!==payload.text||path.endsWith('/approve')&&draft.state!=='APPROVED'||path.endsWith('/reject')&&(draft.state!=='REJECTED'||draft.rejection_reason!==payload.reason)||path.endsWith('/copied')&&draft.state!=='COPIED')invalid();
 return {draft};
}
export function receiptPresent(page:AiHistory,receipt:Receipt){
 if(receipt.leadVersion&&page.lead.version<receipt.leadVersion)return false;
 if(receipt.jobId&&!page.jobs.some(j=>j.id===receipt.jobId&&(!receipt.jobVersion||j.version>=receipt.jobVersion)&&(!receipt.cancelled||j.state==='CANCELLED')))return false;
 if(receipt.draft&&(!('drafts' in page)||!page.drafts.some(d=>d.id===receipt.draft!.id&&d.version>=receipt.draft!.version)))return false;
 return true;
}
type Transport=(path:string,options:RequestInit,tenant:string,key?:string)=>Promise<any>;
export type AiState<T>={data:T|null;busy:boolean;ready:boolean;pending:'write'|'refresh'|'inspect'|null;error:string};
// Each mounted panel owns one scope. Both reads and writes take the same synchronous gate.
export class AiPanelWorkflow<T extends AiHistory>{
 readonly requests=new ClientRequests();readonly recovery=new LeadSaveRecovery();
 state:AiState<T>={data:null,busy:false,ready:false,pending:null,error:''};
 private kind:'analyses'|'drafts';private tenant:string;private lead:string;private send:Transport;
 private change:(state:AiState<T>)=>void;private boundary:AiBoundary;private completed:(()=>void)|null=null;
 constructor(kind:'analyses'|'drafts',tenant:string,lead:string,send:Transport,change:(state:AiState<T>)=>void,boundary:AiBoundary={}){this.kind=kind;this.tenant=tenant;this.lead=lead;this.send=send;this.change=change;this.boundary=boundary;}
 open(){this.requests.replace();}
 close(){this.requests.close();this.recovery.clear();this.completed=null;this.state={data:null,busy:false,ready:false,pending:null,error:''};this.boundary.onStateChange?.({busy:false,pending:false});}
 private publish(){this.state={...this.state,pending:this.recovery.pending};this.boundary.onStateChange?.({busy:this.state.busy,pending:!!this.state.pending});this.change(this.state);}
 private async page(ticket:RequestTicket,cursor?:string){const value=await this.send(`/api/v1/leads/${this.lead}/${this.kind}`+(cursor?'?cursor='+encodeURIComponent(cursor):''),{signal:ticket.signal},this.tenant);ticket.assertCurrent();return validateAiHistory(this.kind,value,this.tenant,this.lead) as T;}
 private async load(ticket:RequestTicket,cursor?:string,receipt?:Receipt){
  let page=await this.page(ticket,cursor);if(cursor&&this.state.data)page=mergeAiHistory(this.state.data,page);
  const cursors=new Set<string>();
  for(let count=1;receipt&&!receiptPresent(page,receipt)&&page.next_cursor&&count<20;count++){const next=page.next_cursor;if(cursors.has(next))invalid();cursors.add(next);page=mergeAiHistory(page,await this.page(ticket,next));}
  if(receipt&&!receiptPresent(page,receipt))throw new LeadWorkflowError('Save acknowledged; refreshed history has not confirmed it yet. Recover to read again.');
  ticket.assertCurrent();this.state={...this.state,data:page,ready:true};this.publish();return page;
 }
 private async action(work:(ticket:RequestTicket)=>Promise<void>){
  if(this.boundary.canStart?.()===false)return false;const ticket=this.requests.beginAction();if(!ticket)return false;
  this.state={...this.state,busy:true,error:''};this.publish();let ok=false;
  try{await work(ticket);ticket.assertCurrent();ok=true;}catch(error){if(ticket.isCurrent()){this.state={...this.state,ready:false,error:(error as Error).message};if([401,403,404].includes((error as {status?:number}).status??0)){this.recovery.clear();this.state={...this.state,data:null};this.completed=null;this.boundary.onAccessDenied?.(error);}this.publish();}}
  finally{this.requests.finishAction(ticket);if(ticket.isCurrent()){this.state={...this.state,busy:false};this.publish();const done=this.completed;this.completed=null;if(ok)done?.();}}
  return ok;
 }
 async refresh(cursor?:string){if(this.recovery.pending==='write')return false;if(this.recovery.pending)return this.recover();return this.action(ticket=>this.load(ticket,cursor).then(()=>{}));}
 async recover(){return this.action(async ticket=>{await this.recovery.recover(ticket);});}
 async save(path:string,payload:unknown,method='POST',complete?:(receipt:Receipt)=>void){
  if(!this.state.ready||this.recovery.pending)return false;const body=JSON.stringify(payload),input=JSON.parse(body);let receipt:Receipt={};
  return this.action(ticket=>this.recovery.start(ticket,{replayable:true,write:async(current,key)=>{const result=await this.send(path,{method,body,signal:current.signal},this.tenant,key);current.assertCurrent();receipt=validateAiReceipt(result,path,input,this.tenant,this.lead);},load:current=>this.load(current,undefined,receipt).then(()=>{}),complete:()=>{this.completed=()=>complete?.(receipt);}}).then(()=>{}));
 }
 async copy(draft:Draft,clipboard:(text:string)=>Promise<void>,complete?:(receipt:Receipt)=>void,onCopied?:()=>void){
  if(!this.state.ready||this.recovery.pending)return false;
  if(draft.tenant_id!==this.tenant||draft.lead_id!==this.lead||draft.freshness!=='CURRENT'||!['APPROVED','COPIED'].includes(draft.state)||draft.safety_flags.length)return false;
  const copy=createCopyOperation(this.send,this.tenant,this.lead,draft,clipboard,onCopied);let receipt:Receipt={};
  return this.action(ticket=>this.recovery.start(ticket,{replayable:true,write:async(current,key)=>{receipt=await copy(current,key);},load:current=>this.load(current,undefined,receipt).then(()=>{}),complete:()=>{this.completed=()=>complete?.(receipt);}}).then(()=>{}));
 }
}
// Retained in the original save closure: successful local copying is never repeated on recovery.
export function createCopyOperation(send:Transport,tenant:string,lead:string,draft:Draft,clipboard:(text:string)=>Promise<void>,onCopied?:()=>void){
 draft=structuredClone(draft);
 const authBody=JSON.stringify({expected_version:draft.version}),receiptKey=crypto.randomUUID();let copied=false,receiptBody:string|null=null;
 return async(ticket:RequestTicket,key:string):Promise<Receipt>=>{
  ticket.assertCurrent();
  if(!copied){const authorization=parse(z.object({text:z.string().min(1).max(5000),expected_version:version,copy_token:z.uuid(),expires_at:stamp}),await send(`/api/v1/drafts/${draft.id}/copy`,{method:'POST',body:authBody,signal:ticket.signal},tenant,key));ticket.assertCurrent();
   if(authorization.expected_version!==draft.version||authorization.text!==draft.working_text||Date.parse(authorization.expires_at)<=Date.now())invalid();
   await clipboard(authorization.text);copied=true;ticket.assertCurrent();receiptBody=JSON.stringify({expected_version:authorization.expected_version,copy_token:authorization.copy_token});onCopied?.();
  }
  ticket.assertCurrent();if(!receiptBody)invalid();
  const path=`/api/v1/drafts/${draft.id}/copied`,result=await send(path,{method:'POST',body:receiptBody,signal:ticket.signal},tenant,receiptKey);ticket.assertCurrent();return validateAiReceipt(result,path,JSON.parse(receiptBody),tenant,lead);
 };
}
