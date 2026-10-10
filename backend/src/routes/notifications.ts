import {api,checkOrigin,readJson,databaseError} from '@leadpilot/backend/server/http';
import {requireTenant} from '@leadpilot/backend/server/supabase';
import {validate,uuid,requestKey,decodeCursor} from '@leadpilot/backend/domain/contracts';
import {notificationSchema,notificationListSchema} from '@leadpilot/backend/domain/notifications';
type Context={params:Promise<{id:string}>};
export const GET=(request:Request)=>api(async()=>{
 const {db,tenantId}=await requireTenant(request),input=validate(notificationListSchema,Object.fromEntries(new URL(request.url).searchParams)),cursor=decodeCursor(input.cursor);
 const {data,error}=await db.rpc('list_notifications',{p_tenant:tenantId,p_filter:input.filter,p_limit:input.limit+1,p_cursor_time:cursor?.created_at??null,p_cursor_id:cursor?.id??null});if(error)databaseError(error);
 const rows=data.slice(0,input.limit),last=rows.at(-1);return {notifications:rows,pagination:{next_cursor:data.length>input.limit&&last?Buffer.from(JSON.stringify({created_at:last.created_at,id:last.id})).toString('base64url'):null}};
});
export const summary=(request:Request)=>api(async()=>{const {db,tenantId}=await requireTenant(request);const {data,error}=await db.rpc('notification_summary',{p_tenant:tenantId});if(error)databaseError(error);return data;});
export const PATCH=(request:Request,context:Context)=>api(async requestId=>{checkOrigin(request);const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id),input=validate(notificationSchema,await readJson(request));
 const {data,error}=await db.rpc('update_notification',{p_tenant:tenantId,p_notification:id,p_payload:input,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
});
export const open=(request:Request,context:Context)=>api(async()=>{const {db,tenantId}=await requireTenant(request),id=validate(uuid,(await context.params).id);const {data,error}=await db.rpc('open_notification',{p_tenant:tenantId,p_notification:id});if(error)databaseError(error);return data;});
