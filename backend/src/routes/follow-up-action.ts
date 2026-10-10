import { api,checkOrigin,readJson,databaseError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { validate,uuid,requestKey } from '@leadpilot/backend/domain/contracts';
import { taskActionSchemas } from '@leadpilot/backend/domain/workflows';
import { z } from 'zod';
export async function POST(request:Request,context:{params:Promise<{id:string;action:string}>}){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);const params=await context.params;const id=validate(uuid,params.id);const action=validate(z.enum(['complete','reschedule','cancel']),params.action);
 const input=validate(taskActionSchemas[action] as z.ZodType<unknown>,await readJson(request));const {data,error}=await db.rpc('change_follow_up',{p_tenant:tenantId,p_task:id,p_action:action,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
});}
