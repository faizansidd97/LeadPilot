import type { RequestTicket } from './client-workflow';

export type Membership={id:string;tenant_id:string;role:'OWNER'|'ADMIN'|'AGENT';agencies:{name:string;timezone:string}};
export type SessionSnapshot={userId:string;memberships:Membership[];active:Membership|null;leads:any[]};
export type SessionRead=(path:string,options:RequestInit,tenant?:string)=>Promise<any>;
export class SessionReadError extends Error {
 status:number;
 constructor(message:string,status=503){super(message);this.status=status;}
}
export function sessionFailurePhase(error:unknown):'login'|'recovery' {
 return (error as {status?:number})?.status===401?'login':'recovery';
}
function invalid():never {throw new SessionReadError('Workspace response could not be verified. Please retry.');}

// No partial snapshot is published. Every chosen agency comes from the fresh cookie-authorized list.
export async function loadWorkspaceSession(ticket:RequestTicket,read:SessionRead,
 options:{tenant?:string;choose?:boolean;expectedUser?:string}={}):Promise<SessionSnapshot> {
 ticket.assertCurrent();
 const data=await read('/api/v1/me/memberships',{signal:ticket.signal});ticket.assertCurrent();
 if(!data||typeof data.user?.id!=='string'||!data.user.id||!Array.isArray(data.memberships))invalid();
 if(options.expectedUser&&data.user.id!==options.expectedUser)
  throw new SessionReadError('Your account changed. Reopen your workspace before continuing.',401);
 const memberships:Membership[]=data.memberships;
 if(memberships.some(m=>!m||typeof m.id!=='string'||!m.id||typeof m.tenant_id!=='string'||!m.tenant_id||
  !['OWNER','ADMIN','AGENT'].includes(m.role)||typeof m.agencies?.name!=='string'||typeof m.agencies?.timezone!=='string')||
  new Set(memberships.map(m=>m.tenant_id)).size!==memberships.length)invalid();
 const active=options.choose?null:options.tenant?memberships.find(m=>m.tenant_id===options.tenant)??null:
  memberships.length===1?memberships[0]:null;
 if(options.tenant&&!active)throw new SessionReadError('Agency access changed. Refresh your agency list before continuing.',403);
 if(!active)return {userId:data.user.id,memberships,active:null,leads:[]};
 const result=await read('/api/v1/leads?limit=100',{signal:ticket.signal},active.tenant_id);ticket.assertCurrent();
 if(!Array.isArray(result?.leads)||result.leads.some((lead:any)=>!lead||typeof lead!=='object'||
  typeof lead.id!=='string'||typeof lead.full_name!=='string'||
  (lead.locations!=null&&(!Array.isArray(lead.locations)||lead.locations.some((value:any)=>typeof value!=='string')))))invalid();
 return {userId:data.user.id,memberships,active,leads:result.leads};
}

export async function completeSessionSignOut(ticket:RequestTicket,read:SessionRead):Promise<void> {
 ticket.assertCurrent();
 const result=await read('/api/v1/auth/sign-out',{method:'POST',signal:ticket.signal});ticket.assertCurrent();
 if(result?.signed_out!==true)throw new SessionReadError('Sign out could not be confirmed. Please retry.');
}
