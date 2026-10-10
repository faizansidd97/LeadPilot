import {createHash} from 'node:crypto';
import {z} from 'zod';
import {ApiError} from './http.ts';
import {intakeEncryptionKey,decryptIntakeSecret,encryptIntakeSecret,type IntakeKeyEnv} from './intake-crypto.ts';
import {intakeRotationSchema,rotationKeyId,type IntakeRotationOptions} from '../domain/intake-rotation.ts';
import type {WorkerDb} from './notification-worker.ts';
const envelope=z.object({id:z.uuid(),encryption_revision:z.number().int().positive(),encryption_key_id:rotationKeyId,secret_cipher:z.string().regex(/^[a-f0-9]{184}$/),secret_aad:z.string().min(1).max(500),secret_hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const stateSchema=z.object({key_id:rotationKeyId,version:z.number().int().positive(),counts:z.record(rotationKeyId,z.number().int().nonnegative())}).strict();
type Envelope=z.infer<typeof envelope>;
export type RotationReport={mode:string;target_key_id:string;policy_key_id:string|null;policy_version:number|null;scanned:number;needs_rewrap:number;rewrapped:number;complete_inventory:boolean;live_rewrap_complete:boolean;status:'READY'|'INCOMPLETE'|'BLOCKED';signing_root_retirement_evaluated:false;backup_key_retirement_approved:false};
export class IntakeRotationError extends ApiError{
 report:RotationReport;
 constructor(code:string,report:RotationReport){super(code.includes('CONFLICT')?409:503,code,'Intake encryption operation stopped. Review recorded state before resuming.');this.report={...report,status:'BLOCKED'};}
}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Private operations only. No table access, raw secret output or external side effects. */
export async function rotateIntakeEncryption(db:WorkerDb,input:IntakeRotationOptions,env:IntakeKeyEnv=process.env){
 const options=intakeRotationSchema.parse(input),report:RotationReport={mode:options.mode,target_key_id:options.target,policy_key_id:null,policy_version:null,scanned:0,needs_rewrap:0,rewrapped:0,complete_inventory:false,live_rewrap_complete:false,status:'INCOMPLETE',signing_root_retirement_evaluated:false,backup_key_retirement_approved:false};
 const known=['VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','INTAKE_KEY_POLICY_CONFLICT','VALIDATION_FAILED','WORKER_REQUIRED','NOT_FOUND'];
 async function call(name:string,args?:Record<string,unknown>){
  for(let attempt=0;attempt<2;attempt++){
   try{const result=await db.rpc(name,args);if(!result.error)return result.data;const code=result.error.message??'';if(known.includes(code))throw new IntakeRotationError(code,report);}
   catch(error){if(error instanceof IntakeRotationError)throw error;}
  }
  throw new IntakeRotationError('INTAKE_ROTATION_DB_UNAVAILABLE',report);
 }
 try{
  // AES operations validate storage dependencies only; root issuance/retirement is separate.
  intakeEncryptionKey(options.target,env);
  const start=stateSchema.parse(await call('worker_intake_encryption_state'));report.policy_key_id=start.key_id;report.policy_version=start.version;
  intakeEncryptionKey(start.key_id,env);
  if(['activate','rewrap'].includes(options.mode)&&options.expected_policy_version!==start.version)throw new IntakeRotationError('VERSION_CONFLICT',report);
  if(options.mode==='rewrap'&&start.key_id!==options.target)throw new IntakeRotationError('INTAKE_KEY_POLICY_CONFLICT',report);
  const rows:Envelope[]=[];let after:string|null=null;
  while(true){
   const page=z.array(envelope).max(25).parse(await call('worker_list_intake_encryption',{p_after:after,p_limit:Math.min(25,options.max_records-rows.length)}));
   for(const row of page){
    if(after&&row.id<=after)throw new IntakeRotationError('INTAKE_ROTATION_INVALID_PAGE',report);
    const secret=decryptIntakeSecret(row.secret_cipher,row.secret_aad,undefined,row.encryption_key_id,env);if(digest(secret)!==row.secret_hash)throw new IntakeRotationError('INTAKE_ROTATION_INVALID_CREDENTIAL',report);
    rows.push(row);report.scanned++;if(row.encryption_key_id!==options.target)report.needs_rewrap++;after=row.id;
   }
   if(page.length<25){report.complete_inventory=true;break;}
   if(rows.length>=options.max_records){const more=z.array(envelope).max(1).parse(await call('worker_list_intake_encryption',{p_after:after,p_limit:1}));report.complete_inventory=more.length===0;break;}
  }
  const checked=stateSchema.parse(await call('worker_intake_encryption_state'));
  if(checked.version!==start.version||checked.key_id!==start.key_id)throw new IntakeRotationError('INTAKE_KEY_POLICY_CONFLICT',report);
  const counts=Object.fromEntries(Object.entries(start.counts).sort()),current=Object.fromEntries(Object.entries(checked.counts).sort());
  if(JSON.stringify(counts)!==JSON.stringify(current)||Object.values(current).reduce((a,b)=>a+b,0)!==rows.length)report.complete_inventory=false;
  if(!report.complete_inventory)return report;
  if(options.mode==='activate'&&start.key_id!==options.target){
   const result=await call('worker_set_intake_encryption_key',{p_target:options.target,p_expected_version:start.version,p_reference:options.reference,p_key:crypto.randomUUID(),p_request_id:crypto.randomUUID()});
   report.policy_key_id=result.key_id;report.policy_version=result.version;
  }
  if(options.mode==='rewrap')for(const row of rows){
   if(row.encryption_key_id===options.target)continue;
   const secret=decryptIntakeSecret(row.secret_cipher,row.secret_aad,undefined,row.encryption_key_id,env),cipher=encryptIntakeSecret(secret,row.secret_aad,options.target,env);
   if(decryptIntakeSecret(cipher,row.secret_aad,undefined,options.target,env)!==secret)throw new IntakeRotationError('INTAKE_ROTATION_INVALID_CREDENTIAL',report);
   const result=await call('worker_rewrap_intake_encryption',{p_payload:{integration_id:row.id,expected_encryption_revision:row.encryption_revision,expected_policy_version:start.version,old_key_id:row.encryption_key_id,old_cipher_hash:digest(row.secret_cipher),target_key_id:options.target,cipher,reference:options.reference},p_key:crypto.randomUUID(),p_request_id:crypto.randomUUID()});
   if(result.encryption_key_id!==options.target)throw new IntakeRotationError('INTAKE_KEY_POLICY_CONFLICT',report);report.rewrapped++;
  }
  const expectedFinishVersion=report.policy_version;
  const finish=stateSchema.parse(await call('worker_intake_encryption_state'));report.policy_key_id=finish.key_id;report.policy_version=finish.version;
  if(finish.version!==expectedFinishVersion)throw new IntakeRotationError('INTAKE_KEY_POLICY_CONFLICT',report);
  if(finish.key_id!==report.target_key_id&&['activate','rewrap','verify'].includes(options.mode))return report;
  report.live_rewrap_complete=finish.key_id===options.target&&Object.entries(finish.counts).every(([id,count])=>id===options.target||count===0);
  report.status=options.mode==='verify'&&!report.live_rewrap_complete?'INCOMPLETE':'READY';return report;
 }catch(error){if(error instanceof IntakeRotationError)throw error;throw new IntakeRotationError('INTAKE_ROTATION_BLOCKED',report);}
}
