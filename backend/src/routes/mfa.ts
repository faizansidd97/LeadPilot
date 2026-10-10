import {z} from 'zod';
import {api,checkOrigin,readJson,ApiError} from '@leadpilot/backend/server/http';
import {requireUser} from '@leadpilot/backend/server/supabase';
import {validate} from '@leadpilot/backend/domain/contracts';
import {recentMfa,authenticatorQr} from '@leadpilot/backend/server/mfa-utils';
import {authError} from '../server/auth-errors.ts';
export const GET=()=>api(async()=>{const {db}=await requireUser();const {data,error}=await db.auth.mfa.listFactors();if(error)throw authError(error,'mfa-list');const claims=await db.auth.getClaims();return {factors:data.all.filter(f=>f.factor_type==='totp').map(f=>({id:f.id,friendly_name:f.friendly_name,status:f.status})),recent:!claims.error&&recentMfa(claims.data?.claims)};});
export const POST=(request:Request)=>api(async()=>{
 checkOrigin(request);const {db}=await requireUser('mutation');const input=validate(z.discriminatedUnion('action',[z.object({action:z.literal('enroll')}).strict(),z.object({action:z.literal('cancel-pending'),factor_id:z.uuid()}).strict(),z.object({action:z.literal('verify'),factor_id:z.uuid(),code:z.string().regex(/^\d{6}$/)}).strict()]),await readJson(request));
 if(input.action==='cancel-pending'){const factors=await db.auth.mfa.listFactors();if(factors.error)throw authError(factors.error,'mfa-list');if(!factors.data.all.some(f=>f.factor_type==='totp'&&f.id===input.factor_id&&f.status==='unverified'))throw new ApiError(422,'MFA_RESET_DENIED','Only your unfinished authenticator enrollment can be removed here.');const {error}=await db.auth.mfa.unenroll({factorId:input.factor_id});if(error)throw authError(error,'mfa-reset');return {message:'Unfinished setup cleared. Set up your authenticator again.'};}
 if(input.action==='enroll'){const {data,error}=await db.auth.mfa.enroll({factorType:'totp',friendlyName:'LeadPilot authenticator',issuer:'LeadPilot'});if(error)throw authError(error,'mfa-enroll');return {factor_id:data.id,qr_code:authenticatorQr(data.totp.qr_code),secret:data.totp.secret};}
 const {error}=await db.auth.mfa.challengeAndVerify({factorId:input.factor_id,code:input.code});if(error)throw authError(error,'mfa-verify');return {message:'Authenticator verified. Complete the sensitive action within five minutes.'};
});
