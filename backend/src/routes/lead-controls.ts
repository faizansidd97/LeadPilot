import { api,checkOrigin,readJson,databaseError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { validate,uuid,requestKey } from '@leadpilot/backend/domain/contracts';
import { controlSchemas,type ControlAction } from '@leadpilot/backend/domain/lead-controls';
import type { z } from 'zod';
type Context={params:Promise<{id:string}>};
function handle(request:Request,context:Context,action:ControlAction){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);
 const input=validate(controlSchemas[action] as z.ZodType<unknown>,await readJson(request));
 const {data,error}=await db.rpc('mutate_lead_control',{p_tenant:tenantId,p_lead:id,p_action:action,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
});}
export const assignment=(request:Request,context:Context)=>handle(request,context,'assignment');
export const archive=(request:Request,context:Context)=>handle(request,context,'archive');
export const restore=(request:Request,context:Context)=>handle(request,context,'restore');
export const contactPreference=(request:Request,context:Context)=>handle(request,context,'contact-preference');
export async function GET(request:Request,context:Context){return api(async()=>{
 const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);
 const {data,error}=await db.rpc('lead_control_summary',{p_tenant:tenantId,p_lead:id});if(error)databaseError(error);return data;
});}
