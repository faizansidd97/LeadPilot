import {z} from 'zod';
import {ApiError} from './http.ts';
import {intakeSigningRootKey,intakeEncryptionKey,type IntakeKeyEnv} from './intake-crypto.ts';
import {rotationKeyId} from '../domain/intake-rotation.ts';
import type {WorkerDb} from './notification-worker.ts';
export const intakeRootRotationSchema=z.object({mode:z.enum(['plan','activate','verify']),target:rotationKeyId,expected_policy_version:z.number().int().positive().max(2147483647).optional(),reference:z.string().trim().min(5).max(200).optional(),request_key:z.uuid().optional()}).strict().superRefine((v,c)=>{if(v.mode==='activate'&&(!v.expected_policy_version||!v.reference||!v.request_key))c.addIssue({code:'custom',message:'Activation requires a reviewed version, reference and reusable request key.'});});
const stateSchema=z.object({key_id:rotationKeyId,version:z.number().int().positive(),issuance_counts:z.record(rotationKeyId,z.number().int().nonnegative()),encryption_key_id:rotationKeyId,key_retirement_approved:z.literal(false)}).strict();
export async function rotateIntakeSigningRoot(db:WorkerDb,options:z.infer<typeof intakeRootRotationSchema>,env:IntakeKeyEnv=process.env){
 const input=intakeRootRotationSchema.parse(options);
 const call=async(name:string,args?:Record<string,unknown>)=>{const r=await db.rpc(name,args);if(r.error)throw new ApiError(503,'INTAKE_ROOT_ROTATION_FAILED','Intake signing operation could not complete. Retry with the same request key.');return r.data;};
 let state=stateSchema.parse(await call('worker_intake_signing_state'));
 const preflight=()=>{for(const id of new Set([state.key_id,input.target,...Object.keys(state.issuance_counts)]))intakeSigningRootKey(id,env);intakeEncryptionKey(state.encryption_key_id,env);};
 preflight();let replayed=false;
 if(input.mode==='activate'){
  const result=z.object({key_id:rotationKeyId,version:z.number().int().positive(),replayed:z.boolean()}).strict().parse(await call('worker_set_intake_signing_root',{p_target:input.target,p_expected_version:input.expected_policy_version,p_reference:input.reference,p_key:input.request_key,p_request_id:crypto.randomUUID()}));
  replayed=result.replayed;state=stateSchema.parse(await call('worker_intake_signing_state'));preflight();
 }
 return {status:input.mode==='plan'||state.key_id===input.target?'READY':'BLOCKED',mode:input.mode,target:input.target,active_root_id:state.key_id,policy_version:state.version,encryption_key_id:state.encryption_key_id,issuance_counts:state.issuance_counts,replayed,key_retirement_approved:false,fleet_readiness_verified:false};
}
