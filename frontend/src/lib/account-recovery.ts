import type {RequestTicket} from './client-workflow';
export type AccountRead=(path:string,options:RequestInit)=>Promise<any>;
export type VerifiedAccount={id:string;email:string};
export type MfaFactor={id:string;friendly_name?:string;status:'verified'|'unverified'};
export type MfaSnapshot={factors:MfaFactor[];recent:boolean};
export type MfaEnrollment={factor_id:string;qr_code:string;secret:string};
export class AccountRecoveryError extends Error {
 status:number;uncertain:boolean;
 constructor(message:string,status=503,uncertain=false){super(message);this.status=status;this.uncertain=uncertain;}
}

// Read once per mounted page: effect replay sees memory rather than the already-scrubbed URL.
export class InvitationFragment {
 private initialized=false;
 private token='';
 read(hash:string,scrub:()=>void):string {
  if(this.initialized)return this.token;
  const values=new URLSearchParams(hash.replace(/^#/,'')),tokens=values.getAll('token');
  const value=tokens.length===1&&/^[a-f0-9]{64}$/.test(tokens[0])?tokens[0]:'';
  if(hash)scrub();
  this.initialized=true;this.token=value;return value;
 }
 clear(){this.initialized=true;this.token='';}
}
export async function readVerifiedAccount(ticket:RequestTicket,read:AccountRead,expected?:string):Promise<VerifiedAccount> {
 ticket.assertCurrent();const data=await read('/api/v1/me/memberships',{signal:ticket.signal});ticket.assertCurrent();
 const user=data?.user;
 if(typeof user?.id!=='string'||!user.id||typeof user.email!=='string'||!user.email||user.email.length>320)
  throw new AccountRecoveryError('Account details could not be verified. Please retry.');
 if(expected&&user.id!==expected)throw new AccountRecoveryError('Your account changed. Refresh account details before continuing.',401);
 return {id:user.id,email:user.email};
}
export function verifyInvitationReceipt(data:any):void {
 if(typeof data?.tenant_id!=='string'||!data.tenant_id||typeof data?.membership?.id!=='string'||!data.membership.id||
  !['ADMIN','AGENT'].includes(data.membership.role))
  throw new AccountRecoveryError('Invitation acceptance could not be confirmed. Retry the same details.');
}
export async function readMfaSnapshot(ticket:RequestTicket,read:AccountRead):Promise<MfaSnapshot> {
 ticket.assertCurrent();const data=await read('/api/v1/me/mfa',{signal:ticket.signal});ticket.assertCurrent();
 if(!Array.isArray(data?.factors)||typeof data.recent!=='boolean'||data.factors.some((factor:any)=>!factor||
  typeof factor.id!=='string'||!factor.id||!['verified','unverified'].includes(factor.status)||
  (factor.friendly_name!=null&&typeof factor.friendly_name!=='string'))||new Set(data.factors.map((f:any)=>f.id)).size!==data.factors.length)
  throw new AccountRecoveryError('Authenticator details could not be verified. Please refresh.');
 return {factors:data.factors,recent:data.recent};
}
export async function verifyAuthenticator(ticket:RequestTicket,read:AccountRead,factorId:string,code:string):Promise<MfaSnapshot>{
 ticket.assertCurrent();
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(factorId)||!/^\d{6}$/.test(code))
  throw new AccountRecoveryError('Select your authenticator and enter its current six-digit code.',422);
 const before=await readMfaSnapshot(ticket,read);ticket.assertCurrent();
 if(!before.factors.some(f=>f.id===factorId))throw new AccountRecoveryError('This authenticator is unavailable. Refresh authenticators.',422);
 const receipt=await read('/api/v1/me/mfa',{method:'POST',signal:ticket.signal,body:JSON.stringify({action:'verify',factor_id:factorId,code})});ticket.assertCurrent();
 if(typeof receipt?.message!=='string'||!receipt.message.trim()||receipt.message.length>500)
  throw new AccountRecoveryError('Verification could not be confirmed. Refresh authenticators before trying again.');
 const snapshot=await readMfaSnapshot(ticket,read);ticket.assertCurrent();
 if(!snapshot.recent||!snapshot.factors.some(f=>f.id===factorId&&f.status==='verified'))
  throw new AccountRecoveryError('Recent verification could not be confirmed. Refresh authenticators before continuing.');
 return snapshot;
}
export async function enrollAuthenticator(ticket:RequestTicket,read:AccountRead,
 publish:(snapshot:MfaSnapshot)=>void):Promise<MfaEnrollment> {
 const snapshot=await readMfaSnapshot(ticket,read);ticket.assertCurrent();publish(snapshot);
 if(snapshot.factors.length)throw new AccountRecoveryError('Use your existing authenticator or clear its unfinished setup before enrolling again.',422);
 let data:any;
 try{
  data=await read('/api/v1/me/mfa',{method:'POST',signal:ticket.signal,body:JSON.stringify({action:'enroll'})});ticket.assertCurrent();
  if(typeof data?.factor_id!=='string'||!data.factor_id||typeof data.secret!=='string'||!data.secret||data.secret.length>512||
   typeof data.qr_code!=='string'||data.qr_code.length>262144||!/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(data.qr_code))
   throw new AccountRecoveryError('Authenticator setup response could not be verified.');
  return {factor_id:data.factor_id,secret:data.secret,qr_code:data.qr_code};
 }catch(error){
  ticket.assertCurrent();
  const status=(error as {status?:number})?.status;
  if(status===401||status===403)throw error;
  throw new AccountRecoveryError('Authenticator setup could not be confirmed. Refresh factors and clear an unfinished setup before enrolling again.',503,true);
 }
}
