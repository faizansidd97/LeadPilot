import type {RequestTicket} from './client-workflow';

type Read=(path:string,options:RequestInit,tenant:string)=>Promise<any>;
export class LeadWorkflowError extends Error {
 status:number;
 constructor(message:string,status=503){super(message);this.status=status;}
}
const record=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
const version=(value:any)=>Number.isSafeInteger(value)&&value>0;
const cursor=(value:any)=>value===null||typeof value==='string';
function invalid():never {throw new LeadWorkflowError('Lead details could not be verified. Reload to try again.');}

export async function loadLeadSnapshot(ticket:RequestTicket,read:Read,tenant:string,id:string,role:string){
 ticket.assertCurrent();
 const [row,conversation,followups,controlInfo,history,directory]=await Promise.all([
  `/api/v1/leads/${id}`,`/api/v1/leads/${id}/messages?limit=100`,
  `/api/v1/follow-ups?lead_id=${id}&limit=100`,`/api/v1/leads/${id}/control-summary`,
  `/api/v1/leads/${id}/activity?limit=25`,'/api/v1/team/assignment-members',
 ].map(path=>read(path,{signal:ticket.signal},tenant)));
 ticket.assertCurrent();
 if(!record(row)||row.id!==id||row.tenant_id!==tenant||!version(row.version)||typeof row.full_name!=='string'||
  !['NEW','CONTACTED','QUALIFIED','FOLLOW_UP','WON','LOST'].includes(row.status)||
  !Array.isArray(row.locations)||row.locations.some((value:any)=>typeof value!=='string'))invalid();
 if(!record(controlInfo)||!version(controlInfo.lead_version)||!['OWNER','ADMIN','AGENT'].includes(controlInfo.role))invalid();
 if(controlInfo.role!==role)throw new LeadWorkflowError('Your role changed. Reopen your workspace before continuing.',403);
 if(controlInfo.lead_version!==row.version)throw new LeadWorkflowError('This lead changed while loading. Reload its latest state.');
 for(const [page,key] of [[conversation,'messages'],[followups,'follow_ups'],[history,'events']] as const){
  if(!Array.isArray(page?.[key])||!cursor(page?.pagination?.next_cursor)||
   page[key].some((item:any)=>!record(item)||typeof item.id!=='string'||!item.id)||
   new Set(page[key].map((item:any)=>item.id)).size!==page[key].length)invalid();
 }
 if(conversation.messages.some((item:any)=>item.lead_id!==id||item.tenant_id!==tenant)||
  followups.follow_ups.some((item:any)=>item.lead_id!==id||item.tenant_id!==tenant)||
  history.events.some((item:any)=>!record(item.details)||typeof item.event_type!=='string'))invalid();
 if(!Array.isArray(directory?.members)||directory.members.some((member:any)=>!record(member)||typeof member.id!=='string'||typeof member.label!=='string'||!['OWNER','ADMIN','AGENT'].includes(member.role)))invalid();
 return {row,conversation,followups,controlInfo,history,directory};
}

export function verifyLeadReceipt(data:any,id:string,path:string,method:string){
 const row=data?.message??data?.follow_up??data?.lead??data;
 if(!record(row)||typeof row.id!=='string'||!version(row.version))invalid();
 if(data?.message||data?.follow_up){if(row.lead_id!==id||!version(data.lead_version))invalid();}
 else if(row.id!==id)invalid();
 const taskId=path.match(/^\/api\/v1\/follow-ups\/([^/]+)\//)?.[1];
 const messageId=method==='PATCH'?path.match(/\/messages\/([^/]+)$/)?.[1]:undefined;
 if(taskId&&row.id!==taskId||messageId&&row.id!==messageId)invalid();
}

type SaveWork={replayable:boolean;write:(ticket:RequestTicket,key:string)=>Promise<void>;load:(ticket:RequestTicket)=>Promise<void>;complete:()=>void};
type Pending=SaveWork&{key:string;phase:'write'|'refresh'|'inspect'};
// Only the original operation can be recovered. No automatic retry of version-only writes.
export class LeadSaveRecovery {
 private attempt:Pending|null=null;
 private readonly retainWriteFailure:(error:unknown)=>boolean;
 constructor(retainWriteFailure:(error:unknown)=>boolean=()=>false){this.retainWriteFailure=retainWriteFailure;}
 get pending(){return this.attempt?.phase??null;}
 clear(){this.attempt=null;}
 async start(ticket:RequestTicket,work:SaveWork){
  ticket.assertCurrent();if(this.attempt)throw new LeadWorkflowError('Recover the previous save before starting another.');
  const attempt:Pending={...work,key:crypto.randomUUID(),phase:'write'};this.attempt=attempt;
  return this.finish(ticket,attempt);
 }
 async recover(ticket:RequestTicket){ticket.assertCurrent();if(!this.attempt)return 'idle' as const;return this.finish(ticket,this.attempt);}
 private async finish(ticket:RequestTicket,attempt:Pending):Promise<'completed'|'review'>{
  try{
   ticket.assertCurrent();
   if(attempt.phase==='write'){await attempt.write(ticket,attempt.key);ticket.assertCurrent();attempt.phase='refresh';}
   await attempt.load(ticket);ticket.assertCurrent();
   if(this.attempt!==attempt)throw new DOMException('Save scope changed.','AbortError');
   this.attempt=null;
   if(attempt.phase==='inspect')return 'review';
   attempt.complete();return 'completed';
  }catch(error){
   if(ticket.isCurrent()&&this.attempt===attempt){
    const status=(error as {status?:number})?.status;
    const retain=attempt.phase==='write'&&this.retainWriteFailure(error);
    if(!retain&&([401,403,404].includes(status??0)||attempt.phase==='write'&&[400,409,422].includes(status??0)))this.attempt=null;
    else if(attempt.phase==='write'&&!attempt.replayable)attempt.phase='inspect';
   }
   throw error;
  }
 }
}
