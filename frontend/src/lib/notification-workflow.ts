import {notificationSchema,notificationPageSchema,notificationSummarySchema,notificationReceiptSchema,notificationTargetSchema,type NotificationRow,type NotificationFilter} from '../../../backend/src/domain/notifications.ts';
import {ClientRequests,type RequestTicket} from './client-workflow.ts';
import {LeadSaveRecovery,LeadWorkflowError} from './lead-workflow.ts';
import {loadFactsLead} from './facts-workflow.ts';

type Transport=(path:string,options:RequestInit,tenant:string,key?:string)=>Promise<any>;
export type NotificationPage={rows:NotificationRow[];cursor:string|null};
export type NotificationTarget={kind:'lead';row:Record<string,unknown>}|{kind:'team'}|null;
function invalid():never{throw new LeadWorkflowError('Notifications could not be verified. Refresh or recover before continuing.');}
// Preserve sub-millisecond PostgreSQL ordering rather than rounding cursor timestamps to milliseconds.
function clock(stamp:string){return BigInt(Date.parse(stamp))*1000000n+BigInt((stamp.match(/\.(\d+)/)?.[1]??'').padEnd(9,'0').slice(3,9));}
const before=(a:NotificationRow,b:NotificationRow)=>clock(a.created_at)>clock(b.created_at)||clock(a.created_at)===clock(b.created_at)&&a.id.toLowerCase()>b.id.toLowerCase();
const sameTime=(a:string|null,b:string|null)=>a===null?b===null:b!==null&&clock(a)===clock(b);
export function validateNotificationPage(value:unknown,filter:NotificationFilter,after:NotificationRow|null=null):NotificationPage{
 const parsed=notificationPageSchema.safeParse(value);if(!parsed.success)invalid();const {notifications:rows,pagination}=parsed.data;
 let previous=after;
 for(const row of rows){if(previous&&!before(previous,row)||filter==='ALL'&&row.dismissed_at!==null||filter==='UNREAD'&&(row.read_at!==null||row.dismissed_at!==null)||filter==='DISMISSED'&&row.dismissed_at===null)invalid();previous=row;}
 if(new Set(rows.map(row=>row.id.toLowerCase())).size!==rows.length)invalid();
 if(pagination.next_cursor){try{const cursor=JSON.parse(atob(pagination.next_cursor.replaceAll('-','+').replaceAll('_','/'))),last=rows.at(-1);if(rows.length!==25||!last||cursor.id!==last.id||cursor.created_at!==last.created_at||Object.keys(cursor).length!==2)invalid();}catch{invalid();}}
 return {rows,cursor:pagination.next_cursor};
}
export async function loadNotificationSummary(ticket:RequestTicket,send:Transport,tenant:string){
 ticket.assertCurrent();const result=await send('/api/v1/notifications/summary',{signal:ticket.signal},tenant);ticket.assertCurrent();const parsed=notificationSummarySchema.safeParse(result);if(!parsed.success)invalid();return parsed.data.unread_count;
}
export function verifyNotificationReceipt(value:unknown,row:NotificationRow,kind:'read'|'dismiss'){
 const parsed=notificationReceiptSchema.safeParse(value);if(!parsed.success)invalid();const receipt=parsed.data;
 if(receipt.id!==row.id||receipt.version!==row.version+1||kind==='read'&&(receipt.read_at===null||!sameTime(receipt.dismissed_at,row.dismissed_at))||kind==='dismiss'&&(receipt.dismissed_at===null||!sameTime(receipt.read_at,row.read_at))||row.read_at!==null&&!sameTime(receipt.read_at,row.read_at)||row.dismissed_at!==null&&!sameTime(receipt.dismissed_at,row.dismissed_at))invalid();
 return receipt;
}
export async function resolveNotificationTarget(ticket:RequestTicket,send:Transport,tenant:string,id:string):Promise<NotificationTarget>{
 ticket.assertCurrent();const value=await send(`/api/v1/notifications/${id}/open`,{signal:ticket.signal},tenant);ticket.assertCurrent();const parsed=notificationTargetSchema.safeParse(value);if(!parsed.success)invalid();
 const target=parsed.data;if(!target.available)return null;if(target.kind==='team')return {kind:'team'};
 try{return {kind:'lead',row:await loadFactsLead(ticket,send,tenant,target.lead_id)};}catch(error){ticket.assertCurrent();if((error as {status?:number}).status===404)return null;throw error;}
}
export type NotificationState=NotificationPage&{filter:NotificationFilter;busy:boolean;ready:boolean;loaded:boolean;pending:'write'|'refresh'|'inspect'|null;error:string;notice:string};
type Callbacks={change:(state:NotificationState)=>void;count:(value:number|null)=>void;open:(target:Exclude<NotificationTarget,null>)=>void};
export class NotificationWorkflow{
 readonly requests=new ClientRequests();readonly recovery=new LeadSaveRecovery();
 state:NotificationState={rows:[],cursor:null,filter:'ALL',busy:false,ready:false,loaded:false,pending:null,error:'',notice:''};
 private tenant:string;private send:Transport;private callbacks:Callbacks;private complete:(()=>void)|null=null;
 constructor(tenant:string,send:Transport,callbacks:Callbacks){this.tenant=tenant;this.send=send;this.callbacks=callbacks;}
 activate(){this.requests.replace();}
 close(){this.requests.close();this.recovery.clear();this.complete=null;this.state={...this.state,rows:[],cursor:null,busy:false,ready:false,loaded:false,pending:null,error:'',notice:''};}
 private publish(){this.state={...this.state,pending:this.recovery.pending};this.callbacks.change(this.state);}
 private async load(ticket:RequestTicket,more=false,receipt?:ReturnType<typeof verifyNotificationReceipt>){
  ticket.assertCurrent();const cursor=more?this.state.cursor:null,filter=this.state.filter,previous=more?this.state.rows:[];
  const [value,count]=await Promise.all([this.send(`/api/v1/notifications?limit=25&filter=${filter}`+(cursor?'&cursor='+encodeURIComponent(cursor):''),{signal:ticket.signal},this.tenant),loadNotificationSummary(ticket,this.send,this.tenant)]);ticket.assertCurrent();
  const page=validateNotificationPage(value,filter,more?previous.at(-1)??null:null);
  if(page.rows.some(row=>previous.some(old=>old.id===row.id)))invalid();
  if(receipt){const row=page.rows.find(row=>row.id===receipt.id);if(row&&(row.version<receipt.version||receipt.read_at!==null&&row.read_at===null||receipt.dismissed_at!==null&&row.dismissed_at===null))throw new LeadWorkflowError('Save acknowledged; refreshed notifications have not confirmed it yet. Recover to read again.');}
  this.state={...this.state,rows:[...previous,...page.rows],cursor:page.cursor,ready:true,loaded:true};this.publish();this.callbacks.count(count);
 }
 private async action(work:(ticket:RequestTicket)=>Promise<void>){
  const ticket=this.requests.beginAction();if(!ticket)return false;this.state={...this.state,busy:true,error:'',notice:''};this.publish();let success=false;
  try{await work(ticket);ticket.assertCurrent();success=true;}catch(error){if(ticket.isCurrent()){this.state={...this.state,ready:false,error:(error as Error).message};this.callbacks.count(null);if([401,403,404].includes((error as {status?:number}).status??0)){this.recovery.clear();this.complete=null;this.state={...this.state,rows:[],cursor:null,loaded:false};}this.publish();}}
  finally{this.requests.finishAction(ticket);if(ticket.isCurrent()){const complete=this.complete;this.complete=null;this.state={...this.state,busy:false};this.publish();if(success&&ticket.isCurrent())complete?.();}}
  return success;
 }
 async refresh(more=false){if(this.recovery.pending==='write')return false;if(this.recovery.pending)return this.recover();if(more&&(!this.state.ready||!this.state.cursor))return false;return this.action(ticket=>this.load(ticket,more));}
 async filter(value:NotificationFilter){if(this.state.busy||this.recovery.pending||!['ALL','UNREAD','DISMISSED'].includes(value))return false;this.state={...this.state,filter:value,rows:[],cursor:null,ready:false,loaded:false,error:'',notice:''};this.publish();this.callbacks.count(null);return this.refresh();}
 async recover(){return this.action(async ticket=>{await this.recovery.recover(ticket);});}
 private current(row:NotificationRow){return this.state.ready&&!this.state.busy&&!this.recovery.pending&&this.state.rows.some(saved=>saved.id===row.id&&saved.version===row.version);}
 private async save(ticket:RequestTicket,row:NotificationRow,kind:'read'|'dismiss',opening=false){
  const body=JSON.stringify(notificationSchema.parse({expected_version:row.version,[kind]:true}));let receipt:ReturnType<typeof verifyNotificationReceipt>,target:NotificationTarget=null;
  await this.recovery.start(ticket,{replayable:true,write:async(current,key)=>{const value=await this.send(`/api/v1/notifications/${row.id}`,{method:'PATCH',body,signal:current.signal},this.tenant,key);current.assertCurrent();receipt=verifyNotificationReceipt(value,row,kind);},load:async current=>{await this.load(current,false,receipt);if(opening){target=null;target=await resolveNotificationTarget(current,this.send,this.tenant,row.id);if(!target)await this.load(current);}},complete:()=>{this.complete=()=>{this.state={...this.state,notice:opening&&!target?'This record is no longer available to your account.':kind==='read'?'Marked as read.':'Notification dismissed.'};this.publish();if(opening&&target)this.callbacks.open(target);};}});
 }
 async change(row:NotificationRow,kind:'read'|'dismiss'){if(!this.current(row)||kind==='read'&&row.read_at!==null||kind==='dismiss'&&row.dismissed_at!==null)return false;const original=structuredClone(row);return this.action(ticket=>this.save(ticket,original,kind));}
 async open(row:NotificationRow){
  if(!this.current(row)||!row.can_open)return false;const original=structuredClone(row);
  return this.action(async ticket=>{const target=await resolveNotificationTarget(ticket,this.send,this.tenant,original.id);ticket.assertCurrent();
   if(!target){await this.load(ticket);ticket.assertCurrent();this.state={...this.state,notice:'This record is no longer available to your account.'};this.publish();return;}
   if(!original.read_at)await this.save(ticket,original,'read',true);
   else this.complete=()=>this.callbacks.open(target);
  });
 }
}
