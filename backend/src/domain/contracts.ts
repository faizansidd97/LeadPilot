import { z } from 'zod';
import { ApiError } from '../server/http.ts';
export function validate<T>(schema:z.ZodType<T>, value:unknown):T {
  const result=schema.safeParse(value);
  if (!result.success) {
    const fields:Record<string,string>={}; for (const issue of result.error.issues) fields[issue.path.join('.')||'_form']=issue.message;
    throw new ApiError(422,'VALIDATION_FAILED','Correct the highlighted fields.',fields);
  }
  return result.data;
}
export const uuid = z.uuid();
export const agencySchema = z.object({name:z.string().trim().min(2).max(120),timezone:z.string().default('Asia/Dubai').refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Use an IANA timezone.'),locale:z.literal('en').default('en')}).strict();
export const authSchema=z.object({email:z.email().max(254),password:z.string().min(8).max(128)}).strict();
export const resetSchema=z.object({email:z.email().max(254)}).strict();
export const messageSchema=z.object({direction:z.enum(['INBOUND','OUTBOUND','INTERNAL']),body:z.string().trim().min(1).max(10000),occurred_at:z.iso.datetime({offset:true}),expected_version:z.number().int().positive()}).strict().refine(value=>Date.parse(value.occurred_at)<=Date.now(),{path:['occurred_at'],message:'Future message times are not allowed.'});
export const paginationSchema=z.object({limit:z.coerce.number().int().min(1).max(100).default(25),q:z.string().max(120).default(''),status:z.enum(['NEW','CONTACTED','QUALIFIED','FOLLOW_UP','WON','LOST']).optional(),cursor:z.string().max(512).optional(),archived:z.enum(['true','false']).default('false')});
export function requestKey(request:Request) {return validate(uuid,request.headers.get('idempotency-key'));}
export function decodeCursor(value?:string) {
  if (!value) return null;
  try {return validate(z.object({created_at:z.iso.datetime({offset:true}),id:uuid}).strict(),JSON.parse(Buffer.from(value,'base64url').toString('utf8')));}
  catch {throw new ApiError(422,'INVALID_CURSOR','Pagination cursor is invalid.');}
}
