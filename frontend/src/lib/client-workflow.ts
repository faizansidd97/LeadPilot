export type RequestTicket={signal:AbortSignal;isCurrent:()=>boolean;assertCurrent:()=>void};
export class ClientRequests {
 private controller=new AbortController();
 private action:RequestTicket|null=null;
 private closed=false;
 capture():RequestTicket {
  const controller=this.controller;
  const isCurrent=()=>this.controller===controller&&!controller.signal.aborted;
  return {signal:controller.signal,isCurrent,assertCurrent:()=>{if(!isCurrent())throw new DOMException('Request scope changed.','AbortError');}};
 }
 replace():RequestTicket {this.controller.abort();this.controller=new AbortController();this.action=null;this.closed=false;return this.capture();}
 close(){this.controller.abort();this.action=null;this.closed=true;}
 beginAction():RequestTicket|null {if(this.closed||this.action?.isCurrent())return null;const ticket=this.replace();this.action=ticket;return ticket;}
 finishAction(ticket:RequestTicket){if(this.action===ticket)this.action=null;}
}
export class MutationRetry {
 private pending:{signature:string;key:string}|null=null;
 clear(){this.pending=null;}
 async run<T>(tenant:string,path:string,method:string,body:unknown,ticket:RequestTicket,
  write:(key:string)=>Promise<T>,after:(data:T)=>Promise<void>):Promise<T> {
  ticket.assertCurrent();
  const signature=JSON.stringify({tenant,path,method,body});
  if(this.pending?.signature!==signature)this.pending={signature,key:crypto.randomUUID()};
  const attempt=this.pending;
  const data=await write(attempt.key);ticket.assertCurrent();
  await after(data);ticket.assertCurrent();
  // A later attempt can never be cleared by an older completion.
  if(this.pending===attempt)this.pending=null;
  return data;
 }
}
