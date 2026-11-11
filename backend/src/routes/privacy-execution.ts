import {api,checkOrigin,readJson,databaseError,ApiError} from '../server/http';
import {requireTenant} from '../server/supabase';
import {validate,uuid,requestKey} from '../domain/contracts';
import {privacyPrepareSchema,privacyStatusSchema,privacyReceiptSchema} from '../domain/privacy-execution';
import {privacyWorkerConfig} from '../server/privacy-worker';
const enabled=()=>{try{privacyWorkerConfig(process.env);return true;}catch{return false;}};
export const GET=(request:Request,context:{params:Promise<{id:string}>})=>api(async()=>{
 const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id);
 const {data,error}=await db.rpc('read_privacy_execution',{p_tenant:tenantId,p_case:id});
 if(error?.code==='PGRST202')throw new ApiError(503,'PRIVACY_UNAVAILABLE','Anonymization is not installed in this workspace yet.');if(error)databaseError(error);
 const result=privacyStatusSchema.safeParse(data);if(!result.success)throw new ApiError(503,'PRIVACY_UNVERIFIED','Privacy progress could not be verified. Refresh to retry.');
 return {...result.data,policy_enabled:result.data.policy_enabled&&enabled()};
});
export const POST=(request:Request,context:{params:Promise<{id:string}>})=>api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);if(!enabled())throw new ApiError(503,'PRIVACY_NOT_CONFIGURED','Anonymization is disabled until the independent manifest store is configured.');
 const id=validate(uuid,(await context.params).id),input=validate(privacyPrepareSchema,await readJson(request));
 const {data,error}=await db.rpc('prepare_privacy_execution',{p_tenant:tenantId,p_case:id,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);
 const result=privacyReceiptSchema.safeParse(data);if(!result.success||result.data.case_id!==id)throw new ApiError(503,'PRIVACY_UNVERIFIED','The save could not be verified. Recover the original request.');return result.data;
},202);
