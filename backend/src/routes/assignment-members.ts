import { api,databaseError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
export async function GET(request:Request){return api(async()=>{
 const {db,tenantId}=await requireTenant(request);const {data,error}=await db.rpc('list_assignment_members',{p_tenant:tenantId});if(error)databaseError(error);return {members:data};
});}
