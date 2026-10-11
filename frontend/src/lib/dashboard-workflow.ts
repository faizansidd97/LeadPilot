import {dashboardSummarySchema,dashboardPageSchema,dashboardMetrics,dashboardQuerySchema,bindDashboardCursor,type DashboardMetric,type DashboardSummary,type DashboardItem} from '../../../backend/src/domain/dashboard.ts';
import {ClientRequests,type RequestTicket} from './client-workflow.ts';
import {loadFactsLead} from './facts-workflow.ts';
import {LeadWorkflowError} from './lead-workflow.ts';

type Transport=(path:string,options:RequestInit,tenant:string)=>Promise<any>;
export type DashboardDates={from:string;to:string};
export type DashboardPage={items:DashboardItem[];cursor:string|null};
export type DashboardState=DashboardPage&{summary:DashboardSummary|null;dates:DashboardDates;ready:boolean;metric:DashboardMetric|null;listReady:boolean;busy:boolean;error:string;listError:string};
function invalid():never{throw new LeadWorkflowError('Dashboard records could not be verified. Refresh metrics or retry the list.');}
function clock(value:string){return BigInt(Date.parse(value))*1000000n+BigInt((value.match(/\.(\d+)/)?.[1]??'').padEnd(9,'0').slice(3,9));}
const sameTime=(a:string,b:string)=>clock(a)===clock(b);
const before=(a:DashboardItem,b:DashboardItem)=>clock(a.sort_at)>clock(b.sort_at)||clock(a.sort_at)===clock(b.sort_at)&&a.row_id.toLowerCase()>b.row_id.toLowerCase();
export function validateDashboardSummary(value:unknown,dates:DashboardDates,timezone:string,role:string):DashboardSummary{
 const parsed=dashboardSummarySchema.safeParse(value);if(!parsed.success)invalid();const s=parsed.data,w=s.window;
 if(!dashboardQuerySchema.safeParse({from:w.from,to:w.to}).success||w.from!==dates.from||w.to!==dates.to||w.timezone!==timezone||!['OWNER','ADMIN','AGENT'].includes(role)||w.manager!==(role!=='AGENT'))invalid();
 try{const day=(stamp:string)=>Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(stamp)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));const start=day(w.start_at),end=day(new Date(Date.parse(w.end_at)-1).toISOString());if(`${start.year}-${start.month}-${start.day}`!==dates.from||`${end.year}-${end.month}-${end.day}`!==dates.to)invalid();}catch{invalid();}
 return s;
}
export function validateDashboardPage(value:unknown,tenant:string,actor:string,metric:DashboardMetric,summary:DashboardSummary,previous:DashboardItem|null=null):DashboardPage{
 const parsed=dashboardPageSchema.safeParse(value);if(!parsed.success)invalid();const {items,pagination}=parsed.data,w=summary.window;let prior=previous;
 if(metric==='UNASSIGNED'&&!w.manager)invalid();
 for(const item of items){
  const payload=item.payload;if(payload.tenant_id!==tenant||payload.id!==item.row_id||prior&&!before(prior,item))invalid();prior=item;
  if(metric==='DUE'){if(item.entity!=='TASK'||!sameTime(item.sort_at,item.payload.due_at)||clock(item.payload.due_at)>clock(w.as_of))invalid();}
  else{
   if(item.entity!=='LEAD'||!sameTime(item.sort_at,item.payload.created_at))invalid();const p=item.payload;
   if(metric==='WON'){if(p.status!=='WON'||!p.won_at||clock(p.won_at)<clock(w.start_at)||clock(p.won_at)>=clock(w.end_at))invalid();}
   else if(metric==='UNASSIGNED'){if(p.assignee_id!==null||['WON','LOST'].includes(p.status))invalid();}
   else{if(clock(p.created_at)<clock(w.start_at)||clock(p.created_at)>=clock(w.end_at)||metric==='QUALIFIED'&&p.status!=='QUALIFIED'||metric.startsWith('STAGE_')&&p.status!==metric.slice(6))invalid();
    if(metric==='CONTACTED_IN_COHORT'){if(!p.first_logged_contact_at||p.contact_latency_seconds===undefined||clock(p.first_logged_contact_at)<clock(p.created_at)||clock(p.first_logged_contact_at)>clock(w.as_of)||Math.abs(p.contact_latency_seconds-Number(clock(p.first_logged_contact_at)-clock(p.created_at))/1e9)>0.000001)invalid();}
   }
  }
 }
 if(new Set(items.map(row=>row.row_id.toLowerCase())).size!==items.length)invalid();
 if(pagination.next_cursor){try{const cursor=bindDashboardCursor(JSON.parse(atob(pagination.next_cursor.replaceAll('-','+').replaceAll('_','/'))),{tenant_id:tenant,actor_id:actor,metric,from:w.from,to:w.to,as_of:w.as_of}),last=items.at(-1);if(items.length!==25||!last||cursor.id!==last.row_id||!sameTime(cursor.sort_at,last.sort_at))invalid();}catch{invalid();}}
 return {items,cursor:pagination.next_cursor};
}
type Callbacks={change:(state:DashboardState)=>void;confirmed:(dates:DashboardDates,metric:DashboardMetric|null,resetDates?:boolean)=>void;open:(row:Record<string,unknown>)=>void};
export class DashboardWorkflow{
 readonly requests=new ClientRequests();state:DashboardState;
 private tenant:string;private actor:string;private timezone:string;private role:string;private send:Transport;private callbacks:Callbacks;
 constructor(scope:{tenant:string;actor:string;timezone:string;role:string;dates:DashboardDates},send:Transport,callbacks:Callbacks){this.tenant=scope.tenant;this.actor=scope.actor;this.timezone=scope.timezone;this.role=scope.role;this.send=send;this.callbacks=callbacks;this.state={summary:null,dates:{...scope.dates},ready:false,metric:null,listReady:false,items:[],cursor:null,busy:false,error:'',listError:''};}
 activate(){this.requests.replace();}
 close(){this.requests.close();this.state={...this.state,summary:null,ready:false,metric:null,listReady:false,items:[],cursor:null,busy:false,error:'',listError:''};}
 private publish(){this.callbacks.change(this.state);}
 private async action(kind:'summary'|'list',work:(ticket:RequestTicket)=>Promise<(()=>void)|void>){
  const ticket=this.requests.beginAction();if(!ticket)return false;this.state={...this.state,busy:true,[kind==='summary'?'error':'listError']:''};this.publish();let complete:(()=>void)|void=undefined,success=false;
  try{complete=await work(ticket);ticket.assertCurrent();success=true;}catch(error){if(ticket.isCurrent()){this.state={...this.state,[kind==='summary'?'ready':'listReady']:false,[kind==='summary'?'error':'listError']:(error as Error).message};if([401,403,404].includes((error as {status?:number}).status??0))this.state={...this.state,summary:null,ready:false,items:[],cursor:null,listReady:false};this.publish();}}
  finally{this.requests.finishAction(ticket);if(ticket.isCurrent()){this.state={...this.state,busy:false};this.publish();if(success&&ticket.isCurrent())complete?.();}}
  return success;
 }
 async refresh(values:DashboardDates){
  if(this.state.busy||!this.requests.capture().isCurrent())return false;const parsed=dashboardQuerySchema.safeParse(values);if(!parsed.success||!parsed.data.from||!parsed.data.to){this.state={...this.state,error:'Choose an ordered date range of at most 366 calendar days.'};this.publish();return false;}const dates={from:parsed.data.from,to:parsed.data.to};
  return this.action('summary',async ticket=>{this.state={...this.state,dates,ready:false,metric:null,items:[],cursor:null,listReady:false,listError:''};this.publish();const value=await this.send('/api/v1/dashboard?'+new URLSearchParams(dates),{signal:ticket.signal},this.tenant);ticket.assertCurrent();const summary=validateDashboardSummary(value,dates,this.timezone,this.role);this.state={...this.state,summary,ready:true};this.publish();return ()=>this.callbacks.confirmed(dates,null,true);});
 }
 async drill(metric:DashboardMetric,more=false){
  if(!this.state.ready||!this.state.summary||!dashboardMetrics.includes(metric)||metric==='UNASSIGNED'&&!this.state.summary.window.manager||more&&(!this.state.listReady||this.state.metric!==metric||!this.state.cursor))return false;
  return this.action('list',async ticket=>{const summary=this.state.summary!,w=summary.window,previous=more?this.state.items:[],cursor=more?this.state.cursor:null;this.state={...this.state,metric,items:previous,cursor,listReady:false};this.publish();const params=new URLSearchParams({from:w.from,to:w.to,metric,as_of:w.as_of,limit:'25'});if(cursor)params.set('cursor',cursor);
   const value=await this.send('/api/v1/dashboard?'+params,{signal:ticket.signal},this.tenant);ticket.assertCurrent();const page=validateDashboardPage(value,this.tenant,this.actor,metric,summary,previous.at(-1)??null);if(page.items.some(row=>previous.some(old=>old.row_id.toLowerCase()===row.row_id.toLowerCase())))invalid();this.state={...this.state,items:[...previous,...page.items],cursor:page.cursor,listReady:true};this.publish();return ()=>this.callbacks.confirmed({from:w.from,to:w.to},metric);
  });
 }
 closeList(){if(!this.requests.capture().isCurrent())return false;this.requests.replace();this.state={...this.state,metric:null,items:[],cursor:null,listReady:false,busy:false,listError:''};this.publish();if(this.state.ready)this.callbacks.confirmed(this.state.dates,null);return true;}
 async open(item:DashboardItem){const current=this.state.items.find(row=>row.row_id===item.row_id&&row.entity===item.entity&&row.payload.id===item.payload.id);if(!this.state.ready||!this.state.listReady||this.state.busy||!current)return false;const id=current.entity==='TASK'?current.payload.lead_id:current.row_id;
  return this.action('list',async ticket=>{const row=await loadFactsLead(ticket,this.send,this.tenant,id);ticket.assertCurrent();if(row.archived_at!==null)throw new LeadWorkflowError('This lead is archived. Refresh metrics before continuing.',404);return ()=>this.callbacks.open(row);});
 }
}
