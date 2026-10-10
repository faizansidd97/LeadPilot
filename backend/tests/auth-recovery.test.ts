import test from 'node:test';
import assert from 'node:assert/strict';
import {AuthApiError,AuthRetryableFetchError,AuthSessionMissingError,AuthInvalidJwtError,AuthInvalidTokenResponseError,AuthUnknownError,AuthInvalidCredentialsError} from '@supabase/supabase-js';
import {authError,verifiedAuthUser,authorizeVerifiedUser,type AuthOperation} from '../src/server/auth-errors.ts';
import {ApiError,api} from '../src/server/http.ts';
const user={id:crypto.randomUUID(),email:'synthetic@example.com',email_confirmed_at:'2026-10-01T00:00:00Z'};
const operations:AuthOperation[]=['session','sign-in','sign-up','reset-password','update-password','sign-out','mfa-list','mfa-enroll','mfa-reset','mfa-verify'];
const safe=(error:ApiError,status:number)=>{assert.equal(error.status,status);assert.doesNotMatch(error.message,/PRIVATE|synthetic@example|https:|password=/);};
test('real SDK retryable network/gateway errors remain 503 across every auth workflow',()=>{
 for(const status of [0,408,500,502,503,504,520,530])for(const operation of operations)safe(authError(new AuthRetryableFetchError('PRIVATE_URL_PASSWORD',status),operation),503);
});
test('real SDK malformed token and unknown transport responses never expire a session or become bad-input errors',()=>{
 for(const error of [new AuthInvalidTokenResponseError(),new AuthUnknownError('PRIVATE_RESPONSE',Error('PRIVATE_CAUSE')),Error('PRIVATE_UNKNOWN'),null,{}, {status:'401'},{status:NaN},{status:200}])for(const operation of operations)safe(authError(error,operation),503);
});
test('Auth throttling preserves 429 without exposing account/provider diagnostics',async()=>{
 for(const operation of operations){const error=authError(new AuthApiError('PRIVATE_EMAIL_DIAGNOSTIC',429,'over_email_send_rate_limit'),operation);safe(error,429);assert.equal(error.code,'AUTH_RATE_LIMITED');}
 for(const code of ['over_request_rate_limit','over_email_send_rate_limit','over_sms_send_rate_limit'])safe(authError(new AuthApiError('PRIVATE',400,code),'session'),429);
 const response=await api(async()=>{throw authError(new AuthApiError('PRIVATE',429,'over_request_rate_limit'),'sign-in');});const body=await response.json();
 assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');assert.equal(body.error.retryable,true);assert.equal(body.error.retry_after,60);assert.equal(response.headers.get('Cache-Control'),'private, no-store');
});
test('known SDK absent/invalid/expired/revoked identity is a definitive 401',()=>{
 for(const error of [new AuthSessionMissingError(),new AuthInvalidJwtError('PRIVATE'),...['bad_jwt','session_not_found','session_expired','refresh_token_not_found','refresh_token_already_used','user_not_found','user_banned','email_not_confirmed'].map(code=>new AuthApiError('PRIVATE',401,code))]){
  const mapped=authError(error,'session');safe(mapped,401);assert.equal(mapped.code,'AUTH_REQUIRED');
 }
});
test('unknown gateway 401/403 does not masquerade as an expired verified session',()=>{
 for(const status of [400,401,403,422])safe(authError(new AuthApiError('PRIVATE_API_KEY_OR_GATEWAY',status,undefined),'session'),503);
 // An upstream outage overrides a misleading denial code.
 safe(authError(new AuthApiError('PRIVATE',503,'session_expired'),'session'),503);
});
test('sign-in bad credentials and unconfirmed email retain generic 401 without account enumeration',()=>{
 for(const error of [new AuthInvalidCredentialsError('PRIVATE_EMAIL'),new AuthApiError('PRIVATE',400,'invalid_credentials'),new AuthApiError('PRIVATE',400,'email_not_confirmed')]){
  const mapped=authError(error,'sign-in');safe(mapped,401);assert.equal(mapped.code,'AUTH_FAILED');
 }
 assert.throws(()=>verifiedAuthUser({data:{user:{...user,email_confirmed_at:undefined}},error:null},'sign-in'),(error:any)=>error.status===401&&error.code==='AUTH_FAILED');
});
test('definitive signup/password/MFA input failures retain operation-specific safe codes',()=>{
 for(const [operation,code] of [['sign-up','SIGN_UP_FAILED'],['update-password','PASSWORD_UPDATE_FAILED'],['mfa-enroll','MFA_ENROLL_FAILED'],['mfa-reset','MFA_RESET_FAILED'],['mfa-verify','MFA_VERIFY_FAILED']] as const){
  const mapped=authError(new AuthApiError('PRIVATE',422,'validation_failed'),operation);safe(mapped,422);assert.equal(mapped.code,code);
 }
 for(const operation of ['reset-password','sign-out','mfa-list'] as const)safe(authError(new AuthApiError('PRIVATE',400,'validation_failed'),operation),503);
});
test('only a complete confirmed user succeeds; malformed successful Auth envelopes fail closed',()=>{
 assert.equal(verifiedAuthUser({data:{user},error:null}),user);
 for(const result of [{data:{user:{...user,id:''}},error:null},{data:{user:{...user,email_confirmed_at:'not-a-date'}},error:null},{data:{user:{...user,email_confirmed_at:true}},error:null},{data:{},error:null},{},null])assert.throws(()=>verifiedAuthUser(result as any),(error:any)=>error.status===503);
 assert.throws(()=>verifiedAuthUser({data:{user:null},error:null}),(error:any)=>error.status===401);
 assert.throws(()=>verifiedAuthUser({data:{user:null},error:null},'sign-in'),(error:any)=>error.status===503);
 assert.throws(()=>verifiedAuthUser({data:{user:{...user,email_confirmed_at:undefined}},error:null}),(error:any)=>error.status===401);
});
test('an Auth error overrides a cached-looking confirmed user and cannot grant authority',()=>{
 for(const error of [new AuthRetryableFetchError('PRIVATE',503),new AuthSessionMissingError(),new AuthApiError('PRIVATE',429,'over_request_rate_limit')])assert.throws(()=>verifiedAuthUser({data:{user},error}),(mapped:any)=>mapped instanceof ApiError);
});
test('authorization blocks database rate/business access for outage, malformed or unverified identity',async()=>{
 let consume=0;
 for(const result of [{data:{user},error:new AuthRetryableFetchError('PRIVATE',503)},{data:{user:null},error:new AuthSessionMissingError()},{data:{user:{...user,email_confirmed_at:undefined}},error:null},{data:{user:{...user,id:''}},error:null}])await assert.rejects(authorizeVerifiedUser<{id:string;email_confirmed_at?:string}>(async()=>result,async()=>{consume++;}));
 assert.equal(consume,0);
});
test('authorization classifies thrown SDK transport/rate failures before any database access',async()=>{
 let consumed=0;
 for(const [error,status] of [[new AuthRetryableFetchError('PRIVATE',0),503],[new AuthApiError('PRIVATE',429,'over_request_rate_limit'),429]] as const)await assert.rejects(authorizeVerifiedUser(async()=>{throw error;},async()=>{consumed++;}),(mapped:any)=>mapped.status===status);
 assert.equal(consumed,0);
});
test('verified identity precedes the database gate; rate/database errors cannot return a user',async()=>{
 const order:string[]=[];const result=await authorizeVerifiedUser(async()=>{order.push('identity');return {data:{user},error:null};},async()=>{order.push('gate');});assert.equal(result,user);assert.deepEqual(order,['identity','gate']);
 const limited=new ApiError(429,'RATE_LIMITED','Wait.');limited.retryAfter=17;
 await assert.rejects(authorizeVerifiedUser(async()=>({data:{user},error:null}),async()=>{throw limited;}),(error:any)=>error===limited&&error.retryAfter===17);
});
test('transient Auth HTTP envelope is private/retryable and does not ask for login or include provider secrets',async()=>{
 const response=await api(async()=>{throw authError(new AuthRetryableFetchError('PRIVATE_PASSWORD_EMAIL_URL',503),'session');});const body=await response.json();
 assert.equal(response.status,503);assert.equal(body.error.code,'AUTH_UNAVAILABLE');assert.equal(body.error.retryable,true);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.doesNotMatch(JSON.stringify(body),/PRIVATE|Sign in/);
});

