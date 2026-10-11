import {manualLeadSchema,assignmentDirectorySchema,inboxRowSchema} from '../../../backend/src/domain/lead-inbox.ts';
import {ClientRequests,type RequestTicket} from './client-workflow.ts';
import {LeadSaveRecovery,LeadWorkflowError} from './lead-workflow.ts';
import {verifyFactsLead,loadFactsLead} from './facts-workflow.ts';
type Read=(path:string,options:RequestInit,tenant:string,key?:string)=>Promise<any>;
export type AddLeadState={members:{id:string;label:string;role:string}[];ready:boolean;busy:boolean;denied:boolean;pending:'write'|'refresh'|'inspect'|null;error:string};
export class AddLeadWorkflow{
 readonly requests=new ClientRequests();readonly recovery=new LeadSaveRecovery();state:AddLeadState={members:[],ready:false,busy:false,denied:false,pending:null,error:''};
 private tenant:string;private role:string;private read:Read;private change:(s:AddLeadState)=>void;private created:(r:Record<string,unknown>)=>void;
 constructor(tenant:string,role:string,read:Read,change:(s:AddLeadState)=>void,created:(r:Record<string,unknown>)=>void){this.tenant=tenant;this.role=role;this.read=read;this.change=change;this.created=created;}
 activate(){this.requests.replace();}
 close(){this.requests.close();this.recovery.clear();this.recovered=null;this.state={members:[],ready:false,busy:false,denied:false,pending:null,error:''};}
 private publish(){this.state={...this.state,pending:this.recovery.pending};this.change(this.state);}
 private async action(work:(ticket:RequestTicket)=>Promise<void|(()=>void)>){if(this.state.denied)return false;const ticket=this.requests.beginAction();if(!ticket)return false;this.state={...this.state,busy:true,error:''};this.publish();let done:void|(()=>void)=undefined,success=false;
  try{done=await work(ticket);ticket.assertCurrent();success=true;}catch(e){if(ticket.isCurrent()){this.state={...this.state,error:(e as Error).message};if([401,403,404].includes((e as {status?:number}).status??0)){this.recovery.clear();this.state={...this.state,members:[],ready:false,denied:true};}this.publish();}}
  finally{this.requests.finishAction(ticket);if(ticket.isCurrent()){this.state={...this.state,busy:false};this.publish();if(success&&ticket.isCurrent())done?.();}}return success;
 }
 async directory(){if(this.recovery.pending)return false;return this.action(async ticket=>{this.state={...this.state,ready:false,members:[]};this.publish();if(!['OWNER','ADMIN','AGENT'].includes(this.role))throw new LeadWorkflowError('Reopen your workspace to restore access.',403);if(this.role==='AGENT'){this.state={...this.state,ready:true};this.publish();return;}
  const value=await this.read('/api/v1/team/assignment-members',{signal:ticket.signal},this.tenant);ticket.assertCurrent();const parsed=assignmentDirectorySchema.safeParse(value);if(!parsed.success)throw new LeadWorkflowError('Assignment choices are unavailable. Refresh them to retry.');this.state={...this.state,members:parsed.data.members,ready:true};this.publish();
 });}
 async save(input:unknown){if(!this.state.ready||this.recovery.pending)return false;return this.action(async ticket=>{const parsed=manualLeadSchema.safeParse(input);if(!parsed.success)throw new LeadWorkflowError(parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join(' '),422);const data=parsed.data;if(this.role==='AGENT'&&Object.hasOwn(data,'assignee_id')||data.assignee_id&&!this.state.members.some(m=>m.id===data.assignee_id))throw new LeadWorkflowError('Choose a current assignment option.',422);
  const body=JSON.stringify(data);let id='',version=1;this.recovered=null;
  await this.recovery.start(ticket,{replayable:true,write:async(current,key)=>{const value=await this.read('/api/v1/leads',{method:'POST',body,signal:current.signal},this.tenant,key);current.assertCurrent();const basic=inboxRowSchema.safeParse(value);if(!basic.success||basic.data.tenant_id!==this.tenant||basic.data.source!=='MANUAL'||basic.data.version!==1||basic.data.status!=='NEW'||basic.data.archived_at!==null||basic.data.full_name!==data.full_name||basic.data.email!==(data.email?data.email.toLowerCase():null)||basic.data.phone!==(data.phone||null)||this.role!=='AGENT'&&basic.data.assignee_id!==(data.assignee_id??null))throw new LeadWorkflowError('Creation acknowledgement could not be verified. Recover the original save.');const row=verifyFactsLead(value,this.tenant,basic.data.id);id=basic.data.id;version=row.version as number;},load:async current=>{const row=await loadFactsLead(current,this.read,this.tenant,id,version);current.assertCurrent();const parsed=inboxRowSchema.safeParse(row);if(!parsed.success)throw new LeadWorkflowError('Saved lead could not be verified. Recover with a fresh read.');this.recovered=parsed.data;},complete:()=>{}});
  const row=this.recovered;return()=>{if(row)this.created(row);};
 });}
 async recover(){if(!this.recovery.pending)return false;return this.action(async ticket=>{
  this.recovered=null;await this.recovery.recover(ticket);ticket.assertCurrent();const row=this.recovered;return()=>{if(row)this.created(row);};
 });}
 private recovered:Record<string,unknown>|null=null;
}
