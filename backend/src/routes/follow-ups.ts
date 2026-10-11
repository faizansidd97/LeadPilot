import { api,checkOrigin,readJson,databaseError,ApiError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { validate,requestKey } from '@leadpilot/backend/domain/contracts';
import { createFollowUpSchema,followUpListSchema,followUpCursorSchema,followUpCursorValue } from '@leadpilot/backend/domain/workflows';
export async function GET(request:Request){return api(async()=>{
 const {db,tenantId}=await requireTenant(request);const input=validate(followUpListSchema,Object.fromEntries(new URL(request.url).searchParams));
 let query=db.from('follow_ups').select('*,leads(id,full_name)').eq('tenant_id',tenantId).order('due_at').order('id').limit(input.limit+1);
 if(input.lead_id)query=query.eq('lead_id',input.lead_id);if(input.state)query=query.eq('state',input.state);
 if(input.cursor){let cursor;try{cursor=validate(followUpCursorSchema,JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));}catch{throw new ApiError(422,'INVALID_CURSOR','Pagination cursor is invalid.');}query=query.or(`due_at.gt.${cursor.due_at},and(due_at.eq.${cursor.due_at},id.gt.${cursor.id})`);}
 const {data,error}=await query;if(error)databaseError(error);const rows=data!;const tasks=rows.slice(0,input.limit);const last=tasks.at(-1);return {follow_ups:tasks,pagination:{next_cursor:rows.length>input.limit&&last?Buffer.from(JSON.stringify(followUpCursorValue(last))).toString('base64url'):null}};
});}
export async function POST(request:Request){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);const input=validate(createFollowUpSchema,await readJson(request));
 const {data,error}=await db.rpc('create_follow_up',{p_tenant:tenantId,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
},201);}
