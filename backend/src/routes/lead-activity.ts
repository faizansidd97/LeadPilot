import { api,databaseError,ApiError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { validate,uuid,decodeCursor } from '@leadpilot/backend/domain/contracts';
import { z } from 'zod';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return api(async()=>{
 const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);
 const {data:lead,error:leadError}=await db.from('leads').select('id').eq('tenant_id',tenantId).eq('id',id).maybeSingle();if(leadError)databaseError(leadError);if(!lead)throw new ApiError(404,'NOT_FOUND','This record is unavailable.');
 const input=validate(z.object({limit:z.coerce.number().int().min(1).max(100).default(25),cursor:z.string().max(512).optional()}).strict(),Object.fromEntries(new URL(request.url).searchParams));const cursor=decodeCursor(input.cursor);
 let query=db.from('activity_events').select('id,actor_id,event_type,reason,created_at,details').eq('tenant_id',tenantId).eq('lead_id',id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(input.limit+1);
 if(cursor)query=query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
 const {data,error}=await query;if(error)databaseError(error);const events=data!.slice(0,input.limit),last=events.at(-1);return {events,pagination:{next_cursor:data!.length>input.limit&&last?Buffer.from(JSON.stringify({created_at:new Date(last.created_at).toISOString(),id:last.id})).toString('base64url'):null}};
});}
