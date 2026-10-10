import {ApiError,databaseError} from './http.ts';
import {invitationToken,invitationSigningKey,tokenHash,deliverInvitation} from './invitations.ts';
import type {WorkerDb} from './notification-worker.ts';
type MailJob={id:string;lease_token:string};
export async function deliverQueuedInvitation(db:WorkerDb,job:MailJob,adapter=deliverInvitation){
 const prepared=await db.rpc('worker_prepare_invitation_mail',{p_job:job.id,p_lease:job.lease_token});if(prepared.error)databaseError(prepared.error);
 const context=prepared.data;let outcome:'EMAIL_ACCEPTED'|'LINK_ONLY'|'TOKEN_ROTATED'|'INVITATION_UNAVAILABLE'='INVITATION_UNAVAILABLE';
 if(context.available){
  if(!process.env.INVITATION_MAIL_URL||!process.env.INVITATION_MAIL_TOKEN)outcome='LINK_ONLY';
  else{const token=invitationToken(invitationSigningKey(context.signing_key_id??'legacy'),context.tenant_id,context.actor_id,context.token_operation,context.request_key);
   if(tokenHash(token)!==context.token_hash)outcome='TOKEN_ROTATED';
   else{if(!process.env.APP_URL)throw new ApiError(503,'INVITATION_MAIL_FAILED','Invitation delivery configuration is incomplete.');const link=new URL('/join',process.env.APP_URL);link.hash='token='+token;
    const delivery=await adapter(context.to,link.toString(),'invitation-mail:'+job.id);if(delivery==='EMAIL_FAILED')throw new ApiError(503,'INVITATION_MAIL_FAILED','Invitation delivery will be retried.');outcome=delivery==='EMAIL_ACCEPTED'?'EMAIL_ACCEPTED':'LINK_ONLY';
   }
  }
 }
 const completed=await db.rpc('worker_complete_invitation_mail',{p_job:job.id,p_lease:job.lease_token,p_result:outcome});if(completed.error)databaseError(completed.error);return completed.data;
}
