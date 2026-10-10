import {z} from 'zod';
import {api,checkOrigin,readJson,databaseError,ApiError} from '../server/http.ts';
import {requireTenant} from '../server/supabase.ts';
import {validate,uuid,requestKey,decodeCursor} from '../domain/contracts.ts';
import {submitAnalysisSchema} from '../domain/analysis.ts';
import {generateDraftSchema,editDraftSchema,reviewDraftSchema,rejectDraftSchema,feedbackDraftSchema,copiedDraftSchema} from '../domain/drafts.ts';
import {draftConfig} from '../server/draft-provider.ts';
type Context={params:Promise<{id:string}>};
export const generate=(request:Request,context:Context)=>api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id),{expected_version,...options}=validate(generateDraftSchema,await readJson(request));
 if(!draftConfig().enabled)throw new ApiError(503,'DRAFT_DISABLED','Reply generation requires approved AI and reviewed-draft configuration. Manual conversation logging remains available.');
 const {data,error}=await db.rpc('submit_draft',{p_tenant:tenantId,p_lead:id,p_expected_version:expected_version,p_options:options,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
},202);
export const history=(request:Request,context:Context)=>api(async()=>{
 const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id),url=new URL(request.url);if([...url.searchParams.keys()].some(k=>k!=='cursor'))throw new ApiError(422,'VALIDATION_FAILED','Use the draft history cursor.');
 const cursor=decodeCursor(validate(z.string().max(512).optional(),url.searchParams.get('cursor')??undefined));
 const lead=await db.from('leads').select('id,context_version,version,do_not_contact,archived_at,status').eq('tenant_id',tenantId).eq('id',id).maybeSingle();if(lead.error)databaseError(lead.error);if(!lead.data)throw new ApiError(404,'NOT_FOUND','This record is unavailable.');
 let query=db.from('ai_jobs').select('id,state,version,input_version,attempts,model,prompt_version,schema_version,requested_at,completed_at,failure_code,usage_state,observed_tokens').eq('tenant_id',tenantId).eq('lead_id',id).eq('kind','DRAFT').order('requested_at',{ascending:false}).order('id',{ascending:false}).limit(26);
 if(cursor)query=query.or(`requested_at.lt.${cursor.created_at},and(requested_at.eq.${cursor.created_at},id.lt.${cursor.id})`);const jobs=await query;if(jobs.error)databaseError(jobs.error);const rows=jobs.data!.slice(0,25),ids=rows.map(j=>j.id);
 const drafts=ids.length?await db.from('reply_drafts').select('*').eq('tenant_id',tenantId).eq('lead_id',id).in('job_id',ids):{data:[],error:null};if(drafts.error)databaseError(drafts.error);
 const agency=await db.from('agencies').select('ai_enabled,processing_approved').eq('id',tenantId).single();if(agency.error)databaseError(agency.error);
 const permitted=!lead.data.archived_at&&!lead.data.do_not_contact&&!['WON','LOST'].includes(lead.data.status),last=rows.at(-1);
 return {enabled:draftConfig().enabled&&agency.data.ai_enabled&&agency.data.processing_approved&&permitted,outreach_allowed:permitted,lead:lead.data,jobs:rows,drafts:drafts.data!.map(d=>({...d,freshness:d.input_version===lead.data!.context_version&&d.state!=='SUPERSEDED'?'CURRENT':'STALE'})),next_cursor:jobs.data!.length>25&&last?Buffer.from(JSON.stringify({created_at:last.requested_at,id:last.id})).toString('base64url'):null};
});
function action(request:Request,context:Context,name:string,schema:z.ZodType){return api(async requestId=>{checkOrigin(request);const {db,tenantId}=await requireTenant(request),input=validate(schema,await readJson(request));if(['APPROVE','COPY_AUTH','COPY_DONE'].includes(name)&&!draftConfig().enabled)throw new ApiError(503,'DRAFT_DISABLED','Reviewed drafts are disabled by server configuration.');const {data,error}=await db.rpc('mutate_draft',{p_tenant:tenantId,p_draft:validate(uuid,(await context.params).id),p_action:name,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;});}
export const edit=(request:Request,context:Context)=>action(request,context,'EDIT',editDraftSchema);
export const approve=(request:Request,context:Context)=>action(request,context,'APPROVE',reviewDraftSchema);
export const reject=(request:Request,context:Context)=>action(request,context,'REJECT',rejectDraftSchema);
export const feedback=(request:Request,context:Context)=>action(request,context,'FEEDBACK',feedbackDraftSchema);
export const authorizeCopy=(request:Request,context:Context)=>action(request,context,'COPY_AUTH',submitAnalysisSchema);
export const copied=(request:Request,context:Context)=>action(request,context,'COPY_DONE',copiedDraftSchema);
const externalSchema=z.object({expected_version:z.number().int().positive(),expected_lead_version:z.number().int().positive(),body:z.string().trim().min(1).max(10000),occurred_at:z.iso.datetime({offset:true}),sent_confirmed:z.literal(true)}).strict().refine(v=>Date.parse(v.occurred_at)<=Date.now(),{path:['occurred_at'],message:'Future message times are not allowed.'});
export const external=(request:Request,context:Context)=>action(request,context,'LOG_EXTERNAL',externalSchema);
export const feedbackSummary=(request:Request)=>api(async()=>{const {db,tenantId}=await requireTenant(request);const {data,error}=await db.rpc('draft_feedback_summary',{p_tenant:tenantId});if(error)databaseError(error);return data;});
