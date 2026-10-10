import {z} from 'zod';
import {ApiError} from './http.ts';
import {invitationSigningKey} from './invitations.ts';
import type {WorkerDb} from './notification-worker.ts';
const keyId=z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).refine(v=>!['constructor','prototype'].includes(v));
export const invitationRotationSchema=z.object({mode:z.enum(['plan','activate','verify']),target:keyId,expected_policy_version:z.number().int().positive().max(2147483647).optional(),reference:z.string().trim().min(5).max(200).optional(),request_key:z.uuid().optional()}).strict().superRefine((v,c)=>{if(v.mode==='activate'&&(!v.expected_policy_version||!v.reference||!v.request_key))c.addIssue({code:'custom',message:'Activation requires reviewed version, reference and reusable request key.'});});
const stateSchema=z.object({key_id:keyId,version:z.number().int().positive(),issuance_counts:z.record(keyId,z.number().int().nonnegative()),key_retirement_approved:z.literal(false)}).strict();
export async function rotateInvitationSigning(db:WorkerDb,options:z.infer<typeof invitationRotationSchema>,env:Record<string,string|undefined>=process.env){
 const input=invitationRotationSchema.parse(options);
 const call=async(name:string,args?:Record<string,unknown>)=>{const r=await db.rpc(name,args);if(r.error)throw new ApiError(503,'INVITATION_ROTATION_FAILED','Invitation signing operation could not complete. Retry with the same request key.');return r.data;};
 let state=stateSchema.parse(await call('worker_invitation_signing_state'));
 // Validate every retained issuance dependency before any policy write. Never print key values.
 for(const id of new Set([state.key_id,input.target,...Object.keys(state.issuance_counts)]))invitationSigningKey(id,env);
 let replayed=false;
 if(input.mode==='activate'){
  const result=z.object({key_id:keyId,version:z.number().int().positive(),replayed:z.boolean()}).strict().parse(await call('worker_set_invitation_signing_key',{p_target:input.target,p_expected_version:input.expected_policy_version,p_reference:input.reference,p_key:input.request_key,p_request_id:crypto.randomUUID()}));
  replayed=result.replayed;state=stateSchema.parse(await call('worker_invitation_signing_state'));
  for(const id of new Set([state.key_id,...Object.keys(state.issuance_counts)]))invitationSigningKey(id,env);
 }
 return {status:input.mode==='plan'||state.key_id===input.target?'READY':'BLOCKED',mode:input.mode,target:input.target,active_key_id:state.key_id,policy_version:state.version,issuance_counts:state.issuance_counts,replayed,key_retirement_approved:false,fleet_readiness_verified:false};
}
