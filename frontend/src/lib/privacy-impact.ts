import {privacyImpactSchema,type PrivacyImpact} from '@leadpilot/backend/domain/privacy';
import type {RequestTicket} from './client-workflow.ts';
type ImpactScope={tenantId:string;caseId:string;caseVersion:number;caseState:PrivacyImpact['case_state']};
export async function loadPrivacyImpact(scope:ImpactScope,ticket:RequestTicket,
 read:(path:string,options:RequestInit,tenant:string)=>Promise<unknown>,clock:()=>number=Date.now):Promise<PrivacyImpact>{
 ticket.assertCurrent();
 const value=await read('/api/v1/privacy/'+scope.caseId+'/impact?expected_version='+scope.caseVersion,{signal:ticket.signal},scope.tenantId);
 ticket.assertCurrent();
 const parsed=privacyImpactSchema.safeParse(value);
 if(!parsed.success||parsed.data.tenant_id!==scope.tenantId||parsed.data.case_id!==scope.caseId||
  parsed.data.case_version!==scope.caseVersion||parsed.data.case_state!==scope.caseState)
  throw Error('The impact preview could not be verified. Refresh case records and try again.');
 const age=clock()-Date.parse(parsed.data.as_of);
 if(!Number.isFinite(age)||age>120000||age< -30000)throw Error('This impact snapshot is out of date. Refresh the preview.');
 return parsed.data;
}
