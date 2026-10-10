import {createHash,createHmac} from 'node:crypto';
import {ApiError} from './http.ts';
export function invitationToken(secret:string,tenant:string,actor:string,operation:string,key:string){
 if(!/^[a-f0-9]{64,}$/.test(secret))throw new ApiError(503,'INVITATIONS_NOT_CONFIGURED','Invitation setup is incomplete.');
 return createHmac('sha256',secret).update(JSON.stringify([tenant,actor,operation,key])).digest('hex');
}
export const tokenHash=(token:string)=>createHash('sha256').update(token).digest('hex');
export function invitationSigningKey(id='legacy',env:Record<string,string|undefined>=process.env){
 const unavailable=()=>new ApiError(503,'INVITATIONS_NOT_CONFIGURED','Invitation signing key inventory is incomplete.');
 if(!/^[a-z][a-z0-9_-]{0,39}$/.test(id)||['constructor','prototype'].includes(id))throw unavailable();
 let keys:Record<string,string>={};
 if(env.INVITATION_TOKEN_KEYS?.trim()){
  try{const input:unknown=JSON.parse(env.INVITATION_TOKEN_KEYS);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>10)throw Error();
   for(const [name,value] of Object.entries(input)){if(name==='legacy'||['__proto__','constructor','prototype'].includes(name)||!/^[a-z][a-z0-9_-]{0,39}$/.test(name)||typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw Error();}
   keys=input as Record<string,string>;
  }catch{throw unavailable();}
 }
 const secret=id==='legacy'?env.INVITATION_TOKEN_SECRET:Object.hasOwn(keys,id)?keys[id]:undefined;
 if(!secret||!(/^[a-f0-9]{64,}$/).test(secret))throw unavailable();return secret;
}
export async function deliverInvitation(to:string,link:string,key:string,transport=fetch){
 const url=process.env.INVITATION_MAIL_URL,secret=process.env.INVITATION_MAIL_TOKEN;
 if(!url||!secret)return 'LINK_ONLY' as const;
 try{const endpoint=new URL(url);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password) return 'EMAIL_FAILED' as const;
 const response=await transport(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+secret,'Idempotency-Key':key},body:JSON.stringify({to,subject:'Join your agency on LeadPilot',text:'Use your verified email to accept this invitation within 72 hours: '+link,idempotency_key:key})});
 return response.ok?'EMAIL_ACCEPTED' as const:'EMAIL_FAILED' as const;
 }catch{return 'EMAIL_FAILED' as const;}
}
