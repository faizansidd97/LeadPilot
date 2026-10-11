import {verifyOperationsSnapshot,analysisUsageSchema,type AnalysisUsage} from '../../../backend/src/domain/operations-progress.ts';
import type {OperationsSnapshot} from '../../../backend/src/domain/operations.ts';
import {ClientRequests} from './client-workflow.ts';
type Read=(path:string,options:RequestInit,tenant:string)=>Promise<unknown>;
export type SnapshotState<T>={data:T|null;busy:boolean;loaded:boolean;denied:boolean;error:string};
const empty=<T>():SnapshotState<T>=>({data:null,busy:false,loaded:false,denied:false,error:''});
export class SnapshotWorkflow<T> {
 readonly requests=new ClientRequests();state:SnapshotState<T>=empty<T>();
 readonly tenant:string;private path:'/api/v1/agency/operations'|'/api/v1/agency/ai-usage';private parse:(value:unknown)=>T;private read:Read;private changed:()=>void;
 constructor(tenant:string,path:'/api/v1/agency/operations'|'/api/v1/agency/ai-usage',parse:(value:unknown)=>T,read:Read,changed:()=>void){this.tenant=tenant;this.path=path;this.parse=parse;this.read=read;this.changed=changed;}
 activate(){this.requests.replace();this.state=empty<T>();}
 close(){this.requests.close();this.state=empty<T>();}
 async refresh():Promise<boolean>{
  if(this.state.denied)return false;const ticket=this.requests.beginAction();if(!ticket)return false;
  this.state={...empty<T>(),busy:true};this.changed();let success=false;
  try{ticket.assertCurrent();const response=await this.read(this.path,{signal:ticket.signal},this.tenant);ticket.assertCurrent();let data:T;
   try{data=this.parse(response);}catch{throw Error('This snapshot could not be verified. Refresh to load current information.');}ticket.assertCurrent();
   this.state={...empty<T>(),data,loaded:true,busy:true};success=true;
  }catch(error){if(ticket.isCurrent()){const status=(error as {status?:number})?.status,denied=!!status&&[401,403,404].includes(status);this.state={...empty<T>(),busy:true,denied,error:denied?'Access changed. Reopen Settings to check your current permissions.':error instanceof Error?error.message.slice(0,2000):'This snapshot is unavailable. Refresh to try again.'};}}
  finally{if(ticket.isCurrent()){this.state={...this.state,busy:false};this.requests.finishAction(ticket);this.changed();}}
  return success&&ticket.isCurrent();
 }
}
export const operationsWorkflow=(tenant:string,read:Read,changed:()=>void)=>new SnapshotWorkflow<OperationsSnapshot>(tenant,'/api/v1/agency/operations',verifyOperationsSnapshot,read,changed);
export const usageWorkflow=(tenant:string,read:Read,changed:()=>void)=>new SnapshotWorkflow<AnalysisUsage>(tenant,'/api/v1/agency/ai-usage',value=>analysisUsageSchema.parse(value),read,changed);
