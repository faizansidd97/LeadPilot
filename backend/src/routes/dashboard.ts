import {api,ApiError,databaseError} from '../server/http.ts';
import {requireTenant} from '../server/supabase.ts';
import {validate} from '../domain/contracts.ts';
import {dashboardQuerySchema,bindDashboardCursor,dashboardCursorValue} from '../domain/dashboard.ts';
export const GET=(request:Request)=>api(async()=>{
 const {db,tenantId,user}=await requireTenant(request),input=validate(dashboardQuerySchema,Object.fromEntries(new URL(request.url).searchParams));
 if(!input.metric){const {data,error}=await db.rpc('dashboard_summary',{p_tenant:tenantId,p_from:input.from??null,p_to:input.to??null});if(error)databaseError(error);return data;}
 let cursor=null;
 if(input.cursor){try{cursor=bindDashboardCursor(JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')),{tenant_id:tenantId,actor_id:user.id,metric:input.metric,from:input.from??'',to:input.to??'',as_of:input.as_of??''});}catch{throw new ApiError(422,'INVALID_CURSOR','Refresh this metric before continuing its pages.');}}
 const {data,error}=await db.rpc('dashboard_drilldown',{p_tenant:tenantId,p_metric:input.metric,p_from:input.from,p_to:input.to,p_as_of:input.as_of,p_limit:input.limit+1,p_cursor_time:cursor?.sort_at??null,p_cursor_id:cursor?.id??null});if(error)databaseError(error);
 const items=data.slice(0,input.limit),last=items.at(-1);return {items,pagination:{next_cursor:data.length>input.limit&&last?Buffer.from(JSON.stringify(dashboardCursorValue(last,{tenant_id:tenantId,actor_id:user.id,metric:input.metric,from:input.from!,to:input.to!,as_of:input.as_of!}))).toString('base64url'):null}};
});
