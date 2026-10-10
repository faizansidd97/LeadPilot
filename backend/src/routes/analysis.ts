import {z} from 'zod';
import {api,checkOrigin,readJson,databaseError,ApiError} from '../server/http.ts';
import {requireTenant} from '../server/supabase.ts';
import {validate,uuid,requestKey,decodeCursor} from '../domain/contracts.ts';
import {refreshAnalysisScore,submitAnalysisSchema} from '../domain/analysis.ts';
import {analysisConfig} from '../server/analysis-provider.ts';
type Context={params:Promise<{id:string}>};
export const submit=(request:Request,context:Context)=>api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id),input=validate(submitAnalysisSchema,await readJson(request));
 if(!analysisConfig().enabled)throw new ApiError(503,'AI_DISABLED','AI analysis requires platform configuration and processing, rubric and language approvals.');
 const {data,error}=await db.rpc('submit_analysis',{p_tenant:tenantId,p_lead:id,p_expected_version:input.expected_version,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
},202);
export const history=(request:Request,context:Context)=>api(async()=>{
 const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id),url=new URL(request.url);if([...url.searchParams.keys()].some(k=>k!=='cursor'))throw new ApiError(422,'VALIDATION_FAILED','Use the analysis history cursor.');
 const cursor=decodeCursor(validate(z.string().max(512).optional(),url.searchParams.get('cursor')??undefined));
 const lead=await db.from('leads').select('id,context_version,current_analysis_id,version,archived_at,status').eq('tenant_id',tenantId).eq('id',id).maybeSingle();if(lead.error)databaseError(lead.error);if(!lead.data)throw new ApiError(404,'NOT_FOUND','This record is unavailable.');
 let query=db.from('ai_jobs').select('id,state,version,input_version,attempts,model,prompt_version,schema_version,requested_at,completed_at,failure_code,usage_state,observed_tokens').eq('tenant_id',tenantId).eq('lead_id',id).eq('kind','ANALYSIS').order('requested_at',{ascending:false}).order('id',{ascending:false}).limit(26);
 if(cursor)query=query.or(`requested_at.lt.${cursor.created_at},and(requested_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
 const rows=await query;if(rows.error)databaseError(rows.error);const jobs=rows.data!.slice(0,25),ids=jobs.map(j=>j.id);
 const results=ids.length?await db.from('ai_analyses').select('*').eq('tenant_id',tenantId).eq('lead_id',id).in('job_id',ids):{data:[],error:null};if(results.error)databaseError(results.error);
 const agency=await db.from('agencies').select('ai_enabled,processing_approved').eq('id',tenantId).single();if(agency.error)databaseError(agency.error);
 const last=jobs.at(-1);return {enabled:analysisConfig().enabled&&agency.data.ai_enabled&&agency.data.processing_approved&&!lead.data.archived_at&&!['WON','LOST'].includes(lead.data.status),lead:lead.data,jobs,analyses:results.data!.map(row=>({...row,result:refreshAnalysisScore(row.result),freshness:row.id===lead.data!.current_analysis_id&&row.input_version===lead.data!.context_version?'CURRENT':'STALE'})),next_cursor:rows.data!.length>25&&last?Buffer.from(JSON.stringify({created_at:last.requested_at,id:last.id})).toString('base64url'):null};
});
export const cancel=(request:Request,context:Context)=>api(async requestId=>{checkOrigin(request);const {db,tenantId}=await requireTenant(request),input=validate(submitAnalysisSchema,await readJson(request));const {data,error}=await db.rpc('cancel_analysis',{p_tenant:tenantId,p_job:validate(uuid,(await context.params).id),p_expected_version:input.expected_version,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;});
export const usage=(request:Request)=>api(async()=>{const {db,tenantId}=await requireTenant(request);const {data,error}=await db.rpc('analysis_usage',{p_tenant:tenantId});if(error)databaseError(error);return data;});
