import {followUpInboxPageSchema,followUpCursorSchema,taskStates,type TaskState,type FollowUpInboxRow} from '../../../backend/src/domain/workflows.ts';
import {ClientRequests,type RequestTicket} from './client-workflow.ts';
import {LeadWorkflowError} from './lead-workflow.ts';
import {loadFactsLead} from './facts-workflow.ts';

type Transport=(path:string,options:RequestInit,tenant:string)=>Promise<any>;
export type FollowUpPage={rows:FollowUpInboxRow[];cursor:string|null};
export type FollowUpQueueState=FollowUpPage&{filter:TaskState;ready:boolean;busy:boolean;loaded:boolean;error:string};
function invalid():never{throw new LeadWorkflowError('Follow ups could not be verified. Refresh the queue before continuing.');}
// Date.parse alone loses the database precision used by the keyset boundary.
function stamp(value:string){return BigInt(Date.parse(value))*1000000n+BigInt((value.match(/\.(\d+)/)?.[1]??'').padEnd(9,'0').slice(3,9));}
const after=(a:FollowUpInboxRow,b:FollowUpInboxRow)=>stamp(a.due_at)>stamp(b.due_at)||stamp(a.due_at)===stamp(b.due_at)&&a.id.toLowerCase()>b.id.toLowerCase();
export function validateFollowUpPage(value:unknown,tenant:string,filter:TaskState,previous:FollowUpInboxRow|null=null):FollowUpPage{
 const parsed=followUpInboxPageSchema.safeParse(value);if(!parsed.success)invalid();const {follow_ups:rows,pagination}=parsed.data;let prior=previous;
 for(const row of rows){if(row.tenant_id!==tenant||row.state!==filter||prior&&!after(row,prior))invalid();prior=row;}
 if(new Set(rows.map(row=>row.id.toLowerCase())).size!==rows.length)invalid();
 if(pagination.next_cursor){try{const raw=JSON.parse(atob(pagination.next_cursor.replaceAll('-','+').replaceAll('_','/'))),cursor=followUpCursorSchema.parse(raw),last=rows.at(-1);if(rows.length!==100||!last||cursor.id!==last.id||stamp(cursor.due_at)!==stamp(last.due_at))invalid();}catch{invalid();}}
 return {rows,cursor:pagination.next_cursor};
}
type Callbacks={change:(state:FollowUpQueueState)=>void;open:(row:Record<string,unknown>)=>void};
export class FollowUpQueue{
 readonly requests=new ClientRequests();
 state:FollowUpQueueState={rows:[],cursor:null,filter:'OPEN',ready:false,busy:false,loaded:false,error:''};
 private tenant:string;private send:Transport;private callbacks:Callbacks;
 constructor(tenant:string,send:Transport,callbacks:Callbacks){this.tenant=tenant;this.send=send;this.callbacks=callbacks;}
 activate(){this.requests.replace();}
 close(){this.requests.close();this.state={...this.state,rows:[],cursor:null,ready:false,busy:false,loaded:false,error:''};}
 private publish(){this.callbacks.change(this.state);}
 private async action(work:(ticket:RequestTicket)=>Promise<Record<string,unknown>|void>){
  const ticket=this.requests.beginAction();if(!ticket)return false;this.state={...this.state,busy:true,error:''};this.publish();let target:Record<string,unknown>|void=undefined,success=false;
  try{target=await work(ticket);ticket.assertCurrent();success=true;}catch(error){if(ticket.isCurrent()){this.state={...this.state,ready:false,error:(error as Error).message};if([401,403,404].includes((error as {status?:number}).status??0))this.state={...this.state,rows:[],cursor:null,loaded:false};this.publish();}}
  finally{this.requests.finishAction(ticket);if(ticket.isCurrent()){this.state={...this.state,busy:false};this.publish();if(success&&target&&ticket.isCurrent())this.callbacks.open(target);}}
  return success;
 }
 async refresh(more=false){
  if(more&&(!this.state.ready||!this.state.cursor))return false;
  return this.action(async ticket=>{
   const previous=more?this.state.rows:[],cursor=more?this.state.cursor:null,filter=this.state.filter;
   const params=new URLSearchParams({state:filter,limit:'100'});if(cursor)params.set('cursor',cursor);
   const value=await this.send('/api/v1/follow-ups?'+params,{signal:ticket.signal},this.tenant);ticket.assertCurrent();const page=validateFollowUpPage(value,this.tenant,filter,previous.at(-1)??null);
   if(page.rows.some(row=>previous.some(old=>old.id.toLowerCase()===row.id.toLowerCase())))invalid();
   this.state={...this.state,rows:[...previous,...page.rows],cursor:page.cursor,ready:true,loaded:true};this.publish();
  });
 }
 async filter(value:TaskState){if(!this.requests.capture().isCurrent()||this.state.busy||!taskStates.includes(value))return false;this.state={...this.state,filter:value,rows:[],cursor:null,ready:false,loaded:false,error:''};this.publish();return this.refresh();}
 async open(row:FollowUpInboxRow){if(!this.state.ready||this.state.busy||!this.state.rows.some(current=>current.id===row.id&&current.version===row.version&&current.lead_id===row.lead_id))return false;const id=row.lead_id;return this.action(ticket=>loadFactsLead(ticket,this.send,this.tenant,id));}
}
