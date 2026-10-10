import {z} from 'zod';
import {api,checkOrigin,readJson,databaseError} from '@leadpilot/backend/server/http';
import {requireTenant,requireUser} from '@leadpilot/backend/server/supabase';
import {validate,uuid,requestKey,decodeCursor} from '@leadpilot/backend/domain/contracts';
import {profileSchema,inviteSchema,inviteActionSchema,acceptInviteSchema,memberSchema,transferOwnerSchema,settingsSchema} from '@leadpilot/backend/domain/team';
import {invitationToken,invitationSigningKey,tokenHash} from '@leadpilot/backend/server/invitations';
type Context={params:Promise<{id:string}>};
export const snapshot=(request:Request)=>api(async()=>{const {db,tenantId}=await requireTenant(request);const {data,error}=await db.rpc('team_snapshot',{p_tenant:tenantId});if(error)databaseError(error);return data;});
async function list(request:Request,name:string,label:string){return api(async()=>{
 const {db,tenantId}=await requireTenant(request),params=new URL(request.url).searchParams;
 const limit=validate(z.coerce.number().int().min(1).max(100),params.get('limit')??25),cursor=decodeCursor(validate(z.string().max(512).optional(),params.get('cursor')??undefined));
 const {data,error}=await db.rpc(name,{p_tenant:tenantId,p_limit:limit+1,p_cursor_time:cursor?.created_at??null,p_cursor_id:cursor?.id??null});if(error)databaseError(error);
 if(label==='invitations'&&(!process.env.INVITATION_MAIL_URL||!process.env.INVITATION_MAIL_TOKEN))for(const row of data??[])row.delivery_state='LINK_ONLY';
 const rows=(data??[]).slice(0,limit),last=rows.at(-1);return {[label]:rows,pagination:{next_cursor:(data??[]).length>limit&&last?Buffer.from(JSON.stringify({created_at:last.created_at,id:last.id})).toString('base64url'):null}};
});}
export const members=(request:Request)=>list(request,'list_team_members','members');
export const invitations=(request:Request)=>list(request,'list_team_invitations','invitations');
function mutate(request:Request,schema:z.ZodType<unknown>,rpc:string,context?:Context){return api(async requestId=>{
 checkOrigin(request);const {db,tenantId}=await requireTenant(request),input=validate(schema,await readJson(request));const args:Record<string,unknown>={p_tenant:tenantId,p_payload:input,p_key:requestKey(request),p_request_id:requestId};
 if(context)args.p_member=validate(uuid,(await context.params).id);const {data,error}=await db.rpc(rpc,args);if(error)databaseError(error);return data;
});}
export const profile=(request:Request)=>mutate(request,profileSchema,'update_my_profile');
export const settings=(request:Request)=>mutate(request,settingsSchema,'update_agency_settings');
export const changeMember=(request:Request,context:Context)=>mutate(request,memberSchema,'change_team_member',context);
export const transferOwner=(request:Request)=>mutate(request,transferOwnerSchema,'transfer_agency_owner');
function invite(request:Request,action:'create'|'resend'|'revoke',context?:Context){return api(async requestId=>{
 checkOrigin(request);const {db,user,tenantId}=await requireTenant(request),key=requestKey(request);const input=validate((action==='create'?inviteSchema:inviteActionSchema) as z.ZodType<unknown>,await readJson(request));
 const id=context?validate(uuid,(await context.params).id):null;
 let signingKeyId='legacy';if(action!=='revoke'){const selection=await db.rpc('invitation_signing_key',{p_tenant:tenantId,p_action:action,p_invite:id,p_key:key,p_payload:input});if(selection.error)databaseError(selection.error);signingKeyId=selection.data;}
 const token=action==='revoke'?null:invitationToken(invitationSigningKey(signingKeyId),tenantId,user.id,action+':'+(id??''),key);
 const args=action==='create'?{p_tenant:tenantId,p_payload:input,p_token_hash:tokenHash(token!),p_key:key,p_request_id:requestId}:{p_tenant:tenantId,p_invite:id,p_action:action,p_payload:input,p_token_hash:token?tokenHash(token):null,p_key:key,p_request_id:requestId};
 const {data,error}=await db.rpc(action==='create'?'create_team_invitation':'change_team_invitation',{...args,p_signing_key_id:signingKeyId});if(error)databaseError(error);
 if(!token)return {invitation:data};const link=new URL('/join',process.env.APP_URL??new URL(request.url).origin);link.hash='token='+token;
 let delivery='LINK_ONLY';if(process.env.INVITATION_MAIL_URL&&process.env.INVITATION_MAIL_TOKEN){const queued=await db.rpc('invitation_delivery_state',{p_tenant:tenantId,p_invite:data.id,p_key:key});if(queued.error)databaseError(queued.error);delivery=queued.data.state==='SUCCEEDED'?'EMAIL_ACCEPTED':queued.data.state==='FAILED'?'EMAIL_FAILED':queued.data.state==='CANCELLED'?'LINK_ONLY':'EMAIL_QUEUED';}
 return {invitation:data,accept_url:link.toString(),delivery};
});}
export const createInvitation=(request:Request)=>invite(request,'create');
export const resend=(request:Request,context:Context)=>invite(request,'resend',context);
export const revoke=(request:Request,context:Context)=>invite(request,'revoke',context);
export const accept=(request:Request)=>api(async requestId=>{checkOrigin(request);const {db}=await requireUser('mutation'),input=validate(acceptInviteSchema,await readJson(request));
 const {data,error}=await db.rpc('accept_team_invitation',{p_token_hash:tokenHash(input.token),p_display_name:input.display_name,p_key:requestKey(request),p_request_id:requestId});if(error)databaseError(error);return data;
});
