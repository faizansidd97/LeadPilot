import {privacyPrepareSchema,privacyReceiptSchema,privacyStatusSchema,type PrivacyStatus} from '../../../backend/src/domain/privacy-execution.ts';
import {PrivacySaveRecovery} from './privacy-workflow.ts';
import type {RequestTicket} from './client-workflow.ts';
type Read=(path:string,options:RequestInit,tenant:string,key?:string)=>Promise<unknown>;
const invalid=()=>Object.assign(Error('Anonymization progress could not be verified. Refresh before continuing.'),{status:503});
export async function readPrivacyExecution(ticket:RequestTicket,read:Read,tenant:string,caseId:string):Promise<PrivacyStatus>{
 ticket.assertCurrent();const data=await read('/api/v1/privacy/'+caseId+'/execution',{signal:ticket.signal},tenant);ticket.assertCurrent();
 const parsed=privacyStatusSchema.safeParse(data);if(!parsed.success)throw invalid();return parsed.data;
}
export async function beginPrivacyExecution(recovery:PrivacySaveRecovery,ticket:RequestTicket,read:Read,tenant:string,caseId:string,input:unknown,publish:(data:PrivacyStatus)=>void){
 ticket.assertCurrent();const body=JSON.stringify(privacyPrepareSchema.parse(input));let savedId:string|null=null;
 return recovery.start(ticket,{replayable:true,write:async(current,key)=>{
  const receipt=privacyReceiptSchema.safeParse(await read('/api/v1/privacy/'+caseId+'/execution',{method:'POST',body,signal:current.signal},tenant,key));current.assertCurrent();
  if(!receipt.success||receipt.data.case_id!==caseId)throw invalid();savedId=receipt.data.id;
 },load:async current=>{const data=await readPrivacyExecution(current,read,tenant,caseId);current.assertCurrent();if(!data.job||data.job.id!==savedId)throw invalid();publish(data);},complete:()=>{}});
}
