import { api,checkOrigin,readJson,databaseError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { captureLeadSchema } from '@leadpilot/backend/domain/capture';
import { paginationSchema,validate,decodeCursor,requestKey,uuid } from '@leadpilot/backend/domain/contracts';
import {attachCurrentScores} from '../server/analysis-read.ts';
export async function GET(request:Request){return api(async()=>{
 const {db,tenantId}=await requireTenant(request);const url=new URL(request.url);const input=validate(paginationSchema,Object.fromEntries(url.searchParams));const cursor=decodeCursor(input.cursor);
 const {data,error}=await db.rpc('list_leads',{p_tenant:tenantId,p_limit:input.limit+1,p_query:input.q,p_status:input.status??null,p_cursor_time:cursor?.created_at??null,p_cursor_id:cursor?.id??null,p_archived:input.archived==='true'});
 if(error)databaseError(error);const rows=data as Record<string,unknown>[];const more=rows.length>input.limit;const leads=rows.slice(0,input.limit);const last=leads.at(-1);
 await attachCurrentScores(db,tenantId,leads);return {leads,pagination:{next_cursor:more&&last?Buffer.from(JSON.stringify({created_at:new Date(last.created_at as string).toISOString(),id:last.id})).toString('base64url'):null}};
});}
export async function POST(request:Request){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);
 const input=validate(captureLeadSchema.safeExtend({assignee_id:uuid.nullable().optional()}),await readJson(request));
 const {data,error}=await db.rpc('create_lead',{p_tenant:tenantId,p_payload:input,p_key:requestKey(request),p_request_id:requestId});
 if(error)databaseError(error);return data;
},201);}
