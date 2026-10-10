import {api,ApiError,databaseError} from '../server/http.ts';
import {requireTenant} from '../server/supabase.ts';
import {operationsSnapshotSchema} from '../domain/operations.ts';
export const GET=(request:Request)=>api(async()=>{
 if(new URL(request.url).search)throw new ApiError(422,'VALIDATION_FAILED','Operations status does not accept query parameters.');
 const {db,tenantId}=await requireTenant(request);const {data,error}=await db.rpc('agency_operations_snapshot',{p_tenant:tenantId});if(error)databaseError(error);
 const result=operationsSnapshotSchema.safeParse(data);if(!result.success)throw new ApiError(503,'OPERATIONS_UNAVAILABLE','Operations status could not be verified. Refresh to retry.');return result.data;
});
