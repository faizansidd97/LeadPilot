import {inboxFilterSchema,inboxPageSchema,inboxRowSchema,leadCursorSchema,type InboxFilter,type InboxRow} from '../../../backend/src/domain/lead-inbox.ts';
import {ClientRequests,type RequestTicket} from './client-workflow.ts';
import {loadFactsLead} from './facts-workflow.ts';
import {LeadWorkflowError} from './lead-workflow.ts';
type Read=(path:string,options:RequestInit,tenant:string)=>Promise<any>;
export type InboxState={filter:InboxFilter;rows:InboxRow[];cursor:string|null;ready:boolean;busy:boolean;error:string};
const clock=(v:string)=>BigInt(Date.parse(v))*1000000n+BigInt((v.match(/\.(\d+)/)?.[1]??'').padEnd(9,'0').slice(3,9));
function invalid():never{throw new LeadWorkflowError('Lead records could not be verified. Refresh the inbox to retry.');}
export function validateInboxPage(value:unknown,tenant:string,filter:InboxFilter,last:InboxRow|null=null){
 const parsed=inboxPageSchema.safeParse(value);if(!parsed.success)invalid();const {leads,pagination}=parsed.data;let previous=last;
 for(const row of leads){const q=filter.q.toLowerCase();if(row.tenant_id!==tenant||!!row.archived_at!==filter.archived||filter.status!=='ALL'&&row.status!==filter.status||q&&!([row.full_name,row.email??'',...row.locations].some(v=>v.toLowerCase().includes(q))||(row.phone??'').includes(filter.q)))invalid();
  if(previous&&!(clock(previous.created_at)>clock(row.created_at)||clock(previous.created_at)===clock(row.created_at)&&previous.id.toLowerCase()>row.id.toLowerCase()))invalid();previous=row;
 }
 if(new Set(leads.map(r=>r.id.toLowerCase())).size!==leads.length)invalid();
 if(pagination.next_cursor){try{const cursor=leadCursorSchema.parse(JSON.parse(atob(pagination.next_cursor.replaceAll('-','+').replaceAll('_','/')))),end=leads.at(-1);if(leads.length!==25||!end||cursor.id!==end.id||clock(cursor.created_at)!==clock(end.created_at))invalid();}catch{invalid();}}
 return {rows:leads,cursor:pagination.next_cursor};
}
export class InboxWorkflow{
 readonly requests=new ClientRequests();state:InboxState;
 private tenant:string;private read:Read;private change:(s:InboxState)=>void;private opened:(r:Record<string,unknown>)=>void;
 constructor(tenant:string,read:Read,change:(s:InboxState)=>void,opened:(r:Record<string,unknown>)=>void){this.tenant=tenant;this.read=read;this.change=change;this.opened=opened;this.state={filter:{q:'',status:'ALL',archived:false},rows:[],cursor:null,ready:false,busy:false,error:''};}
 activate(){this.requests.replace();}
 close(){this.requests.close();this.state={...this.state,rows:[],cursor:null,ready:false,busy:false,error:''};}
 setFilter(input:InboxFilter){const filter=inboxFilterSchema.parse(input);this.requests.replace();this.state={filter:{...filter},rows:[],cursor:null,ready:false,busy:false,error:''};this.change(this.state);}
 private async action(work:(t:RequestTicket)=>Promise<void|(()=>void)>){const ticket=this.requests.beginAction();if(!ticket)return false;this.state={...this.state,busy:true,error:''};this.change(this.state);let done:void|(()=>void)=undefined,success=false;
  try{done=await work(ticket);ticket.assertCurrent();success=true;}catch(e){if(ticket.isCurrent()){this.state={...this.state,ready:false,error:(e as Error).message};if([401,403,404].includes((e as {status?:number}).status??0))this.state={...this.state,rows:[],cursor:null};this.change(this.state);}}
  finally{this.requests.finishAction(ticket);if(ticket.isCurrent()){this.state={...this.state,busy:false};this.change(this.state);if(success&&ticket.isCurrent())done?.();}}return success;
 }
 async refresh(more=false){if(more&&(!this.state.ready||!this.state.cursor))return false;return this.action(async ticket=>{const filter={...this.state.filter},old=more?this.state.rows:[],cursor=more?this.state.cursor:null;this.state={...this.state,ready:false,rows:old,cursor};this.change(this.state);const params=new URLSearchParams({limit:'25',q:filter.q,archived:String(filter.archived)});if(filter.status!=='ALL')params.set('status',filter.status);if(cursor)params.set('cursor',cursor);
  const value=await this.read('/api/v1/leads?'+params,{signal:ticket.signal},this.tenant);ticket.assertCurrent();const page=validateInboxPage(value,this.tenant,filter,old.at(-1)??null);if(page.rows.some(r=>old.some(o=>o.id.toLowerCase()===r.id.toLowerCase())))invalid();this.state={...this.state,rows:[...old,...page.rows],cursor:page.cursor,ready:true};this.change(this.state);
 });}
 async open(id:string){if(!this.state.ready||!this.state.rows.some(r=>r.id===id))return false;return this.action(async ticket=>{const row=await loadFactsLead(ticket,this.read,this.tenant,id),parsed=inboxRowSchema.safeParse(row);if(!parsed.success)invalid();if(!!parsed.data.archived_at!==this.state.filter.archived)throw new LeadWorkflowError('This lead changed archive state. Refresh the inbox before opening.');return()=>this.opened(parsed.data);});}
}
