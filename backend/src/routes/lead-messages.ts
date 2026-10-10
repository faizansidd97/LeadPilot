import { api,checkOrigin,readJson,databaseError,ApiError } from '@leadpilot/backend/server/http';
import { requireTenant } from '@leadpilot/backend/server/supabase';
import { messageSchema,validate,uuid,requestKey,paginationSchema } from '@leadpilot/backend/domain/contracts';
import { z } from 'zod';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return api(async()=>{
 const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);
 const {data:lead,error:leadError}=await db.from('leads').select('id').eq('tenant_id',tenantId).eq('id',id).maybeSingle();
 if(leadError)databaseError(leadError);if(!lead)throw new ApiError(404,'NOT_FOUND','This record is unavailable.');
 const input=validate(paginationSchema,Object.fromEntries(new URL(request.url).searchParams));let cursor:{occurred_at:string;created_at:string;id:string}|null=null;
 if(input.cursor){try{cursor=validate(z.object({occurred_at:z.iso.datetime({offset:true}),created_at:z.iso.datetime({offset:true}),id:uuid}).strict(),JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8')));}catch{throw new ApiError(422,'INVALID_CURSOR','Pagination cursor is invalid.');}}
 let query=db.from('messages').select('*').eq('tenant_id',tenantId).eq('lead_id',id).order('occurred_at',{ascending:false}).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(input.limit+1);
 if(cursor)query=query.or(`occurred_at.lt.${cursor.occurred_at},and(occurred_at.eq.${cursor.occurred_at},created_at.lt.${cursor.created_at}),and(occurred_at.eq.${cursor.occurred_at},created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
 const {data,error}=await query;if(error)databaseError(error);const rows=data!;const messages=rows.slice(0,input.limit);const last=messages.at(-1);
 return {messages,pagination:{next_cursor:rows.length>input.limit&&last?Buffer.from(JSON.stringify({occurred_at:new Date(last.occurred_at).toISOString(),created_at:new Date(last.created_at).toISOString(),id:last.id})).toString('base64url'):null}};
});}
export async function POST(request:Request,context:{params:Promise<{id:string}>}){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request);const id=validate(uuid,(await context.params).id);const input=validate(messageSchema,await readJson(request));
 const {data,error}=await db.rpc('add_lead_message',{p_tenant:tenantId,p_lead:id,p_payload:input,p_key:requestKey(request),p_request_id:requestId});
 if(error)databaseError(error);return data;
},201);}
