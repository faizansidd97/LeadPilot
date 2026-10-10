import {privacyImpactSchema} from '../domain/privacy.ts';
import {ApiError,databaseError} from './http.ts';
type Reader={rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:unknown;error:{message?:string;code?:string}|null}>};
export async function readPrivacyImpact(db:Reader,tenant:string,id:string,version:number){
 const {data,error}=await db.rpc('read_privacy_impact',{p_tenant:tenant,p_case:id,p_expected_version:version});
 if(error?.code==='PGRST202')throw new ApiError(503,'PRIVACY_IMPACT_UNAVAILABLE','The impact preview is not available in this workspace yet.');
 if(error)databaseError(error);
 const parsed=privacyImpactSchema.safeParse(data);
 if(!parsed.success||parsed.data.tenant_id!==tenant||parsed.data.case_id!==id||parsed.data.case_version!==version)
  throw new ApiError(503,'PRIVACY_IMPACT_INVALID','The impact preview could not be verified. Refresh and try again.');
 return parsed.data;
}
