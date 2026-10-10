import {createHash} from 'node:crypto';
import {ApiError,databaseError,readRaw} from './http.ts';
import {decryptIntakeSecret,verifyIntakeSignature} from './intake-crypto.ts';
import {validate} from '../domain/contracts.ts';
import {intakeSchema} from '../domain/capture.ts';
import type {WorkerDb} from './notification-worker.ts';
export async function processSignedIntake(request:Request,id:string,db:WorkerDb,requestId:string,key?:string,now=Date.now()){
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new ApiError(415,'JSON_REQUIRED','Use application/json.');const raw=await readRaw(request);
  const credential=await db.rpc('worker_intake_credential',{p_integration:id});if(credential.error)databaseError(credential.error);if(!credential.data)throw new ApiError(401,'SIGNATURE_INVALID','Website signature is invalid.');
  const secret=decryptIntakeSecret(credential.data.secret_cipher,credential.data.secret_aad,key,credential.data.encryption_key_id??'legacy');if(createHash('sha256').update(secret).digest('hex')!==credential.data.secret_hash)throw new ApiError(503,'INTAKE_NOT_CONFIGURED','Website intake credential could not be loaded.');
  verifyIntakeSignature(secret,request.headers.get('x-intake-timestamp'),request.headers.get('x-intake-signature'),raw,now);
  const gate=await db.rpc('worker_intake_limit',{p_integration:id,p_key_version:credential.data.key_version});if(gate.error)databaseError(gate.error);if(!gate.data.allowed){const error=new ApiError(429,'RATE_LIMITED','Too many website inquiries. Retry later.');error.retryAfter=gate.data.retry_after;throw error;}
  let body:unknown;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new ApiError(400,'INVALID_JSON','Provide valid UTF-8 JSON.');}const input=validate(intakeSchema,body);
  const {data,error}=await db.rpc('worker_ingest_lead',{p_integration:id,p_key_version:credential.data.key_version,p_event:input.external_event_id,p_body_hash:createHash('sha256').update(raw).digest('hex'),p_payload:input.lead,p_occurred:input.occurred_at??null,p_request_id:requestId});if(error)databaseError(error);return data;
}
