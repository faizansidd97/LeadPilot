import { api,checkOrigin,readJson,databaseError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { validate,uuid,requestKey } from '@leadpilot/backend/domain/contracts';
import { statusChangeSchema } from '@leadpilot/backend/domain/workflows';
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);const input=validate(statusChangeSchema,await readJson(request));
 const {data,error}=await db.rpc('change_lead_status',{p_tenant:tenantId,p_lead:id,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
});}
