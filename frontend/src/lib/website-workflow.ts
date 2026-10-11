import {integrationSchema,integrationChangeSchema} from '../../../backend/src/domain/capture.ts';
import {websiteMetadataSchema,websiteListSchema,websiteDirectorySchema,signingSecretSchema,type WebsiteMetadata,type WebsiteMember} from '../../../backend/src/domain/website-progress.ts';
import {ClientRequests,type RequestTicket} from './client-workflow.ts';
import {LeadSaveRecovery,LeadWorkflowError} from './lead-workflow.ts';
type Read=(path:string,options:RequestInit,tenant:string,key?:string)=>Promise<any>;
type Credential={row:WebsiteMetadata;value:string};
export type WebsiteState={integrations:WebsiteMetadata[];members:WebsiteMember[];ready:boolean;busy:boolean;pending:'write'|'refresh'|'inspect'|null;denied:boolean;secret:{id:string;value:string}|null;error:string;notice:string};
const path='/api/v1/integrations/website';
const clock=(s:string)=>BigInt(Date.parse(s))*1000000n+BigInt((s.match(/\.(\d+)/)?.[1]??'').padEnd(9,'0').slice(3,9));
function invalid():never{throw new LeadWorkflowError('Website integration details could not be verified. Reload to retry.');}
export function verifyWebsiteList(value:unknown){const parsed=websiteListSchema.safeParse(value);if(!parsed.success)invalid();const rows=parsed.data.integrations;let prior:WebsiteMetadata|null=null;for(const row of rows){if(prior&&(clock(prior.created_at)<clock(row.created_at)||clock(prior.created_at)===clock(row.created_at)&&prior.id.toLowerCase()>=row.id.toLowerCase()))invalid();prior=row;}if(new Set(rows.map(r=>r.id.toLowerCase())).size!==rows.length)invalid();return rows;}
export function verifyWebsiteDirectory(value:unknown){const parsed=websiteDirectorySchema.safeParse(value);if(!parsed.success)invalid();return parsed.data.members;}
export function verifyWebsiteReceipt(value:any,action:'create'|'rotate'|'revoke',input:any,baseline:WebsiteMetadata|null){
 const parsed=websiteMetadataSchema.safeParse(value);if(!parsed.success)invalid();const row=parsed.data;
 if(action==='create'?(row.name!==input.name||row.default_assignee_id!==input.default_assignee_id||row.version!==1||row.key_version!==1||!row.active):(!baseline||row.id!==baseline.id||row.name!==baseline.name||row.default_assignee_id!==baseline.default_assignee_id||clock(row.created_at)!==clock(baseline.created_at)||row.version!==baseline.version+1||row.key_version!==baseline.key_version+1||row.active!==(action==='rotate')))invalid();
 if(action!=='revoke'){const secret=signingSecretSchema.safeParse(value.signing_secret);if(!secret.success)invalid();return {row,value:secret.data};}
 if(value.signing_secret!==undefined)invalid();return {row,value:null};
}
export class WebsiteWorkflow{
 readonly requests=new ClientRequests();readonly recovery=new LeadSaveRecovery();state:WebsiteState={integrations:[],members:[],ready:false,busy:false,pending:null,denied:false,secret:null,error:'',notice:''};
 private readonly tenant:string;private readonly role:string;private readonly read:Read;private readonly changed:(s:WebsiteState)=>void;private credential:Credential|null=null;private completed:(()=>void)|null=null;
 constructor(tenant:string,role:string,read:Read,changed:(s:WebsiteState)=>void){this.tenant=tenant;this.role=role;this.read=read;this.changed=changed;}
 activate(){this.requests.replace();}
 close(){this.requests.close();this.recovery.clear();this.credential=null;this.completed=null;this.state={...this.state,integrations:[],members:[],ready:false,busy:false,pending:null,secret:null,notice:'',error:''};}
 private publish(){this.state={...this.state,pending:this.recovery.pending};this.changed(this.state);}
 private async action(work:(t:RequestTicket)=>Promise<void>,recover=false){if(this.state.denied||this.recovery.pending&&!recover)return false;const t=this.requests.beginAction();if(!t)return false;this.state={...this.state,busy:true,error:'',notice:'',secret:null};this.publish();let ok=false;
  try{if(!['OWNER','ADMIN'].includes(this.role))throw new LeadWorkflowError('Only managers can manage website integrations.',403);await work(t);t.assertCurrent();ok=true;}
  catch(e){if(t.isCurrent()){this.state={...this.state,error:(e as Error).message,ready:false,secret:null};if([401,403,404].includes((e as {status?:number}).status??0)){this.recovery.clear();this.credential=null;this.completed=null;this.state={...this.state,integrations:[],members:[],denied:true};}this.publish();}}
  finally{this.requests.finishAction(t);if(t.isCurrent()){this.state={...this.state,busy:false};this.publish();const complete=this.completed;this.completed=null;if(ok&&t.isCurrent())complete?.();}}return ok;
 }
 private expose(){const c=this.credential,row=c&&this.state.integrations.find(r=>r.id===c.row.id);if(c&&row&&row.active&&row.version===c.row.version&&row.key_version===c.row.key_version&&row.name===c.row.name&&row.default_assignee_id===c.row.default_assignee_id&&clock(row.created_at)===clock(c.row.created_at)){this.state={...this.state,secret:{id:row.id,value:c.value}};return true;}this.credential=null;this.state={...this.state,secret:null};return false;}
 private async load(t:RequestTicket,acknowledged:WebsiteMetadata|null=null){this.state={...this.state,ready:false,secret:null};this.publish();const [list,directory]=await Promise.all([this.read(path,{signal:t.signal},this.tenant),this.read('/api/v1/team/assignment-members',{signal:t.signal},this.tenant)]);t.assertCurrent();const integrations=verifyWebsiteList(list),members=verifyWebsiteDirectory(directory);const saved=acknowledged&&integrations.find(r=>r.id===acknowledged.id);if(saved&&acknowledged&&(saved.version<acknowledged.version||saved.key_version<acknowledged.key_version))invalid();this.state={...this.state,integrations,members,ready:true};this.expose();this.publish();}
 async refresh(){return this.action(t=>this.load(t));}
 async save(action:'create'|'rotate'|'revoke',id:string|null,input:unknown,complete:()=>void=()=>{}){if(!this.state.ready)return false;return this.action(async t=>{
  const parsed=(action==='create'?integrationSchema:integrationChangeSchema).safeParse(input);if(!parsed.success)throw new LeadWorkflowError('Check the integration name, assignment, action and reason.',422);const data=parsed.data;
  const baseline=action==='create'?null:this.state.integrations.find(r=>r.id===id)??null;
  if(action==='create'?(id!==null||!('default_assignee_id' in data)||data.default_assignee_id!==null&&!this.state.members.some(m=>m.id===data.default_assignee_id)):(!baseline||!baseline.active||!('action' in data)||data.action!==action||data.expected_version!==baseline.version))throw new LeadWorkflowError('Reload current integrations and assignment choices before saving.',409);
  const body=JSON.stringify(data),url=action==='create'?path:path+'/'+baseline!.id;this.credential=null;let acknowledged:WebsiteMetadata|null=null;
  await this.recovery.start(t,{replayable:true,write:async(current,key)=>{this.publish();const value=await this.read(url,{method:action==='create'?'POST':'PATCH',body,signal:current.signal},this.tenant,key);current.assertCurrent();const receipt=verifyWebsiteReceipt(value,action,data,baseline);acknowledged=receipt.row;this.credential=receipt.value?{row:receipt.row,value:receipt.value}:null;},load:current=>this.load(current,acknowledged),complete:()=>{
   const row=this.state.integrations.find(r=>r.id===acknowledged?.id),current=!!row&&row.version===acknowledged?.version&&row.key_version===acknowledged?.key_version&&row.active===acknowledged?.active;
   this.state={...this.state,notice:current?'Integration change saved.': 'The change was acknowledged, but this integration changed again. Its earlier secret is hidden; review current progress.'};this.completed=complete;this.publish();
  }});
 });}
 async recover(){if(!this.recovery.pending)return false;return this.action(async t=>{await this.recovery.recover(t);},true);}
 hideSecret(){this.credential=null;this.state={...this.state,secret:null};this.publish();}
}
