import {ApiError} from './http.ts';

export type AuthOperation='session'|'sign-in'|'sign-up'|'reset-password'|'update-password'|
 'sign-out'|'mfa-list'|'mfa-enroll'|'mfa-reset'|'mfa-verify';
const denied:Record<AuthOperation,[number,string,string]>={
 session:[401,'AUTH_REQUIRED','Sign in with a verified email.'],
 'sign-in':[401,'AUTH_FAILED','Check your credentials and verify your email.'],
 'sign-up':[422,'SIGN_UP_FAILED','Registration could not complete. Check your input or retry later.'],
 'reset-password':[503,'RESET_UNAVAILABLE','Password reset could not complete. Retry later.'],
 'update-password':[422,'PASSWORD_UPDATE_FAILED','Password could not be updated.'],
 'sign-out':[503,'SIGN_OUT_FAILED','Sign out could not complete.'],
 'mfa-list':[503,'MFA_UNAVAILABLE','Authenticator settings are unavailable.'],
 'mfa-enroll':[422,'MFA_ENROLL_FAILED','Authenticator setup could not complete. Use an existing factor or retry.'],
 'mfa-reset':[422,'MFA_RESET_FAILED','Unfinished setup could not be cleared.'],
 'mfa-verify':[422,'MFA_VERIFY_FAILED','Check the current authenticator code.'],
};
const sessionCodes=new Set(['bad_jwt','no_authorization','session_not_found','session_expired',
 'refresh_token_not_found','refresh_token_already_used','user_not_found','user_banned','email_not_confirmed']);
const rateCodes=new Set(['over_request_rate_limit','over_email_send_rate_limit','over_sms_send_rate_limit']);

// Trust structured SDK metadata only, never message text or upstream headers/bodies.
export function authError(error:unknown,operation:AuthOperation):ApiError {
 const value=error&&typeof error==='object'?error as {status?:unknown;code?:unknown;name?:unknown}:{};
 const status=typeof value.status==='number'?value.status:undefined;
 const code=typeof value.code==='string'?value.code:'';
 if(status===429||rateCodes.has(code))return new ApiError(429,'AUTH_RATE_LIMITED','Too many authentication requests. Wait a minute and retry.');
 const unavailable=()=>new ApiError(503,'AUTH_UNAVAILABLE','Authentication service is temporarily unavailable. Please retry.');
 if(value.name==='AuthRetryableFetchError'||value.name==='AuthUnknownError'||value.name==='AuthRefreshDiscardedError'||
  status===undefined||!Number.isInteger(status)||status<=0||status===408||status>=500)return unavailable();
 if(operation==='session'){
  if(value.name==='AuthSessionMissingError'||value.name==='AuthInvalidJwtError'||sessionCodes.has(code))return new ApiError(...denied.session);
  // An unknown gateway 401/configuration error is not evidence that a user's session expired.
  return unavailable();
 }
 if([400,401,403,422].includes(status))return new ApiError(...denied[operation]);
 return unavailable();
}

type UserIdentity={id:string;email_confirmed_at?:string};
type AuthResult<T extends UserIdentity>={data:{user:T|null};error:unknown};
export function verifiedAuthUser<T extends UserIdentity>(result:AuthResult<T>,operation:'session'|'sign-in'='session'):T {
 if(result?.error)throw authError(result.error,operation);
 const user=result?.data?.user;
 if(!user){
  if(operation==='session'&&user===null)throw new ApiError(...denied.session);
  throw new ApiError(503,'AUTH_UNAVAILABLE','Account details could not be verified. Please retry.');
 }
 if(typeof user.id!=='string'||!user.id)throw new ApiError(503,'AUTH_UNAVAILABLE','Account details could not be verified. Please retry.');
 if(!user.email_confirmed_at)throw new ApiError(...denied[operation]);
 if(typeof user.email_confirmed_at!=='string'||!Number.isFinite(Date.parse(user.email_confirmed_at)))
  throw new ApiError(503,'AUTH_UNAVAILABLE','Account details could not be verified. Please retry.');
 return user;
}
export async function authorizeVerifiedUser<T extends UserIdentity>(read:()=>Promise<AuthResult<T>>,consume:()=>Promise<void>):Promise<T> {
 let result:AuthResult<T>;
 try{result=await read();}catch(error){throw authError(error,'session');}
 const user=verifiedAuthUser(result);await consume();return user;
}
