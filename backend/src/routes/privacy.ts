import {z} from 'zod';
import {api,ApiError,checkOrigin,readJson,databaseError} from '../server/http.ts';
import {requireTenant} from '../server/supabase.ts';
import {validate,decodeCursor,requestKey,uuid} from '../domain/contracts.ts';
import {privacyRequestSchema,privacyActionSchema,privacyImpactQuerySchema} from '../domain/privacy.ts';
import {readPrivacyImpact} from '../server/privacy-impact.ts';
export const GET=(request:Request)=>api(async()=>{
 const {db,tenantId}=await requireTenant(request),input=validate(z.object({cursor:z.string().max(512).optional()}).strict(),Object.fromEntries(new URL(request.url).searchParams)),cursor=decodeCursor(input.cursor);
 const {data,error}=await db.rpc('list_privacy_cases',{p_tenant:tenantId,p_cursor_time:cursor?.created_at??null,p_cursor_id:cursor?.id??null});if(error)databaseError(error);const cases=data.slice(0,25),last=cases.at(-1);return {cases,execution_available:false,next_cursor:data.length>25&&last?Buffer.from(JSON.stringify({created_at:new Date(last.created_at).toISOString(),id:last.id})).toString('base64url'):null};
});
export const IMPACT=(request:Request,context:{params:Promise<{id:string}>})=>api(async()=>{
 const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id);
 const input=validate(privacyImpactQuerySchema,Object.fromEntries(new URL(request.url).searchParams));
 return readPrivacyImpact(db,tenantId,id,input.expected_version);
});
export const POST=(request:Request)=>api(async requestId=>{checkOrigin(request);const {db,tenantId}=await requireTenant(request),input=validate(privacyRequestSchema,await readJson(request));const {data,error}=await db.rpc('request_privacy_case',{p_tenant:tenantId,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;},201);
export const PATCH=(request:Request,context:{params:Promise<{id:string}>})=>api(async requestId=>{checkOrigin(request);const {db,tenantId}=await requireTenant(request),input=validate(privacyActionSchema,await readJson(request));const {data,error}=await db.rpc('triage_privacy_case',{p_tenant:tenantId,p_case:validate(uuid,(await context.params).id),p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;});
export const HISTORY=(request:Request,context:{params:Promise<{id:string}>})=>api(async()=>{
 const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id),input=validate(z.object({cursor:z.string().max(512).optional()}).strict(),Object.fromEntries(new URL(request.url).searchParams)),cursor=decodeCursor(input.cursor);
 const parent=await db.from('privacy_cases').select('id').eq('tenant_id',tenantId).eq('id',id).maybeSingle();if(parent.error)databaseError(parent.error);if(!parent.data)throw new ApiError(404,'NOT_FOUND','This privacy record is unavailable.');
 let query=db.from('privacy_case_actions').select('id,action,case_version,reason,created_at').eq('tenant_id',tenantId).eq('case_id',id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(26);
 if(cursor)query=query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
 const {data,error}=await query;if(error)databaseError(error);const actions=data!.slice(0,25),last=actions.at(-1);return {actions,next_cursor:data!.length>25&&last?Buffer.from(JSON.stringify({created_at:new Date(last.created_at).toISOString(),id:last.id})).toString('base64url'):null};
});
