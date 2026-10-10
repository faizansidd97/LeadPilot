import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invitationToken,tokenHash,deliverInvitation} from '../src/server/invitations.ts';
import {recentMfa,authenticatorQr} from '../src/server/mfa-utils.ts';
import {inviteSchema,memberSchema,settingsSchema} from '../src/domain/team.ts';
test('invitation replay tokens bind tenant, actor, operation and key without storing raw tokens',()=>{
 const secret='b'.repeat(64),token=invitationToken(secret,'tenant','actor','create','key');assert.match(token,/^[a-f0-9]{64}$/);assert.equal(token,invitationToken(secret,'tenant','actor','create','key'));assert.notEqual(token,tokenHash(token));
 for(const args of [['other','actor','create','key'],['tenant','other','create','key'],['tenant','actor','resend','key'],['tenant','actor','create','other']])assert.notEqual(token,invitationToken(secret,...args as [string,string,string,string]));
 assert.throws(()=>invitationToken('','tenant','actor','create','key'),/Invitation setup/);
});
test('MFA freshness rejects refreshed password-only sessions, missing timestamps, stale and future factors',()=>{
 assert.equal(recentMfa({aal:'aal2',amr:[{method:'totp',timestamp:950}]},1000),true);
 for(const claims of [{aal:'aal1',amr:[{method:'totp',timestamp:950}]},{aal:'aal2',iat:999,amr:[{method:'password',timestamp:999}]},{aal:'aal2',amr:['totp']},{aal:'aal2',amr:[{method:'totp',timestamp:699}]},{aal:'aal2',amr:[{method:'totp',timestamp:1001}]},{aal:'aal2',amr:[{method:'totp',timestamp:'999'}]}])assert.equal(recentMfa(claims,1000),false);
});
test('team contracts normalize email and reject injected authority, incomplete approvals and invalid limits',()=>{
 assert.equal(inviteSchema.parse({email:'  USER@example.com ',role:'AGENT'}).email,'user@example.com');assert.equal(inviteSchema.safeParse({email:'a@example.com',role:'OWNER'}).success,false);
 assert.equal(memberSchema.safeParse({expected_version:1,active:false,reason:'Offboard',user_id:crypto.randomUUID()}).success,false);
 assert.equal(settingsSchema.safeParse({expected_version:1,name:'Agency',timezone:'Asia/Dubai',processing_approved:false,processing_reference:'',ai_enabled:true,seat_limit:0}).success,false);
});
test('approved mail transport is optional, deduped and reports acceptance distinctly from failed delivery',async()=>{
 const saved=[process.env.INVITATION_MAIL_URL,process.env.INVITATION_MAIL_TOKEN];let calls=0;
 try{delete process.env.INVITATION_MAIL_URL;delete process.env.INVITATION_MAIL_TOKEN;const fake:typeof fetch=async(_url,options)=>{calls++;assert.equal(new Headers(options?.headers).get('Idempotency-Key'),'scope:key');assert.equal(options?.redirect,'error');assert.equal(JSON.parse(String(options?.body)).to,'invited@example.com');return new Response(null,{status:202});};
 assert.equal(await deliverInvitation('invited@example.com','https://app.example/join#token=secret','scope:key',fake),'LINK_ONLY');assert.equal(calls,0);
 process.env.INVITATION_MAIL_URL='https://mail.example/invitations';process.env.INVITATION_MAIL_TOKEN='private';assert.equal(await deliverInvitation('invited@example.com','https://app.example/join#token=secret','scope:key',fake),'EMAIL_ACCEPTED');
 assert.equal(await deliverInvitation('invited@example.com','link','scope:key',async()=>new Response(null,{status:500})),'EMAIL_FAILED');process.env.INVITATION_MAIL_URL='http://mail.example';assert.equal(await deliverInvitation('invited@example.com','link','scope:key',fake),'EMAIL_FAILED');assert.equal(calls,1);
 }finally{for(const [i,key] of ['INVITATION_MAIL_URL','INVITATION_MAIL_TOKEN'].entries()){if(saved[i]===undefined)delete process.env[key];else process.env[key]=saved[i];}}
});

test('authenticator QR renders the installed SDK data URL as SVG rather than encoding its URL prefix',()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';const image=authenticatorQr('data:image/svg+xml;utf-8,'+svg);assert.equal(Buffer.from(image.split(',')[1],'base64').toString(),svg);assert.equal(authenticatorQr(svg),image);assert.throws(()=>authenticatorQr('https://untrusted.example/image'),/manual authenticator setup/);
});
