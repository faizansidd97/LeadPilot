import { api,databaseError,ApiError,checkOrigin,readJson } from '@leadpilot/backend/server/http';
import { updateLeadSchema } from '@leadpilot/backend/domain/lead-update';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { uuid,validate } from '@leadpilot/backend/domain/contracts';
import {attachCurrentScores} from '../server/analysis-read.ts';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return api(async()=>{
 const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);
 const {data,error}=await db.from('leads').select('*').eq('tenant_id',tenantId).eq('id',id).maybeSingle();
 if(error)databaseError(error);if(!data)throw new ApiError(404,'NOT_FOUND','This record is unavailable.');await attachCurrentScores(db,tenantId,[data]);return data;
});}

export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);
 const {expected_version,...input}=validate(updateLeadSchema,await readJson(request));
 const {data,error}=await db.rpc('update_lead',{p_tenant:tenantId,p_lead:id,p_payload:input,p_expected_version:expected_version,p_request_id:requestId});
 if(error)databaseError(error);return data;
});}
