import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {ApiError} from './http.ts';
export type IntakeKeyEnv=Record<string,string|undefined>;
const unavailable=()=>new ApiError(503,'INTAKE_NOT_CONFIGURED','Website intake encryption is not configured.');
export function intakeEncryptionKey(id='legacy',env:IntakeKeyEnv=process.env){
 if(!/^[a-z][a-z0-9_-]{0,39}$/.test(id))throw unavailable();
 let keys:Record<string,string>={};
 if(env.INTAKE_ENCRYPTION_KEYS?.trim()){
  try{const input:unknown=JSON.parse(env.INTAKE_ENCRYPTION_KEYS);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>10)throw Error();
   for(const [name,value] of Object.entries(input)){if(name==='legacy'||['__proto__','constructor','prototype'].includes(name)||!/^[a-z][a-z0-9_-]{0,39}$/.test(name)||typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error();}
   keys=input as Record<string,string>;
  }catch{throw unavailable();}
 }
 const value=id==='legacy'?env.INTAKE_ENCRYPTION_KEY:Object.hasOwn(keys,id)?keys[id]:undefined;
 if(!value||!/^[a-f0-9]{64}$/.test(value))throw unavailable();return Buffer.from(value,'hex');
}
export function intakeSigningRootKey(id='legacy',env:IntakeKeyEnv=process.env){
 if(!/^[a-z][a-z0-9_-]{0,39}$/.test(id)||['constructor','prototype'].includes(id))throw unavailable();
 let keys:Record<string,string>={};
 if(env.INTAKE_SIGNING_ROOT_KEYS?.trim()){
  try{const input:unknown=JSON.parse(env.INTAKE_SIGNING_ROOT_KEYS);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>10)throw Error();
   for(const [name,value] of Object.entries(input)){if(name==='legacy'||['__proto__','constructor','prototype'].includes(name)||!/^[a-z][a-z0-9_-]{0,39}$/.test(name)||typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error();}
   keys=input as Record<string,string>;
  }catch{throw unavailable();}
 }
 const value=id==='legacy'?env.INTAKE_ENCRYPTION_KEY:Object.hasOwn(keys,id)?keys[id]:undefined;
 if(!value||!/^[a-f0-9]{64}$/.test(value))throw unavailable();return Buffer.from(value,'hex');
}
export function encryptIntakeSecret(secret:string,aad:string,keyId='legacy',env:IntakeKeyEnv=process.env){
 if(!/^[a-f0-9]{64}$/.test(secret)||!aad||aad.length>500)throw unavailable();
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',intakeEncryptionKey(keyId,env),nonce);cipher.setAAD(Buffer.from(aad));
 const data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),data]).toString('hex');
}
export function issueIntakeSecret(scope:string,key?:string,keyId='legacy',env:IntakeKeyEnv=process.env,signingRootId='legacy'){
 const config=key!==undefined?{INTAKE_ENCRYPTION_KEY:key}:env;
 // Replay selects the original immutable root, independently of the current AES storage key.
 const root=intakeSigningRootKey(signingRootId,config),secret=createHmac('sha256',root).update('leadpilot-intake-v1:'+scope).digest('hex');
 return {secret,cipher:encryptIntakeSecret(secret,scope,keyId,config),aad:scope,hash:createHash('sha256').update(secret).digest('hex'),encryption_key_id:keyId,signing_root_id:signingRootId};
}
export function decryptIntakeSecret(cipherText:string,aad:string,key?:string,keyId='legacy',env:IntakeKeyEnv=process.env){
 try{
  if(!/^[a-f0-9]{184}$/.test(cipherText)||!aad||aad.length>500)throw Error();
  const bytes=Buffer.from(cipherText,'hex'),config=key!==undefined?{INTAKE_ENCRYPTION_KEY:key}:env;
  const decipher=createDecipheriv('aes-256-gcm',intakeEncryptionKey(keyId,config),bytes.subarray(0,12));decipher.setAAD(Buffer.from(aad));decipher.setAuthTag(bytes.subarray(12,28));
  const secret=Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');if(!/^[a-f0-9]{64}$/.test(secret))throw Error();return secret;
 }catch{throw new ApiError(503,'INTAKE_NOT_CONFIGURED','Website intake credential could not be loaded.');}
}
export function verifyIntakeSignature(secret:string,timestamp:string|null,signature:string|null,raw:Uint8Array,now=Date.now()){
 if(!timestamp||!/^\d{10}$/.test(timestamp)||!signature||!/^[a-f0-9]{64}$/.test(signature)||Math.abs(now-Number(timestamp)*1000)>300000)throw new ApiError(401,'SIGNATURE_INVALID','Website signature is invalid.');
 const expected=createHmac('sha256',secret).update(timestamp+'.').update(raw).digest();if(!timingSafeEqual(expected,Buffer.from(signature,'hex')))throw new ApiError(401,'SIGNATURE_INVALID','Website signature is invalid.');
}
