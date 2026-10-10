import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {invitationSigningKey,invitationToken,tokenHash} from '../src/server/invitations.ts';
import {deliverQueuedInvitation} from '../src/server/queued-invitation.ts';
import {invitationRotationSchema,rotateInvitationSigning} from '../src/server/invitation-key-rotation.ts';
const env={INVITATION_TOKEN_SECRET:'a'.repeat(64),INVITATION_TOKEN_KEYS:JSON.stringify({next:'b'.repeat(64),later:'c'.repeat(64)})};
const state={key_id:'legacy',version:1,issuance_counts:{legacy:3},key_retirement_approved:false};
test('invitation key ring preserves legacy token bytes and selects immutable named keys',()=>{
 assert.equal(invitationSigningKey('legacy',env),env.INVITATION_TOKEN_SECRET);assert.equal(invitationSigningKey('next',env),'b'.repeat(64));
 const args=['tenant','actor','create:','request'] as const;
 assert.equal(invitationToken(invitationSigningKey('legacy',env),...args),invitationToken(env.INVITATION_TOKEN_SECRET,...args));assert.notEqual(invitationToken(invitationSigningKey('next',env),...args),invitationToken(env.INVITATION_TOKEN_SECRET,...args));
});
test('malformed, missing, inherited, oversized and legacy-overriding invitation keys fail closed without leaking values',()=>{
 for(const ring of ['[]','null','{bad}',JSON.stringify({legacy:'b'.repeat(64)}),'{"__proto__":"'+ 'b'.repeat(64)+'"}',JSON.stringify({constructor:'b'.repeat(64)}),JSON.stringify({next:'B'.repeat(64)}),JSON.stringify(Object.fromEntries(Array.from({length:11},(_,i)=>['k'+i,'b'.repeat(64)])))])assert.throws(()=>invitationSigningKey('legacy',{...env,INVITATION_TOKEN_KEYS:ring}),e=>(e as any).status===503&&!(e as Error).message.includes(env.INVITATION_TOKEN_SECRET));
 for(const id of ['missing','constructor','prototype','__proto__','Bad'])assert.throws(()=>invitationSigningKey(id,env),/inventory is incomplete/);
 assert.throws(()=>invitationSigningKey('legacy',{INVITATION_TOKEN_KEYS:env.INVITATION_TOKEN_KEYS}),/inventory is incomplete/);
});
test('operator activation requires a bounded reviewed version, reference and reusable request UUID',()=>{
 assert.ok(invitationRotationSchema.safeParse({mode:'plan',target:'next'}).success);
 for(const input of [{mode:'activate',target:'next'},{mode:'activate',target:'next',expected_policy_version:1,reference:'review-ref'}, {mode:'activate',target:'next',expected_policy_version:1.5,reference:'review-ref',request_key:crypto.randomUUID()}, {mode:'plan',target:'constructor'},{mode:'plan',target:'next',secret:'injection'}])assert.equal(invitationRotationSchema.safeParse(input).success,false);
});
test('operator plan validates every retained key without writes or exposing secrets',async()=>{
 const calls:string[]=[];const db={rpc:async(name:string)=>{calls.push(name);return {data:state,error:null};}};
 const report=await rotateInvitationSigning(db,{mode:'plan',target:'next'},env);assert.equal(report.status,'READY');assert.deepEqual(calls,['worker_invitation_signing_state']);assert.equal(report.key_retirement_approved,false);assert.equal(report.fleet_readiness_verified,false);assert.ok(!JSON.stringify(report).includes('a'.repeat(64)));
 await assert.rejects(()=>rotateInvitationSigning(db,{mode:'activate',target:'next',expected_policy_version:1,reference:'review-ref',request_key:crypto.randomUUID()},{INVITATION_TOKEN_KEYS:env.INVITATION_TOKEN_KEYS}),/inventory is incomplete/);assert.ok(calls.every(n=>n==='worker_invitation_signing_state'));
});
test('activation uses exact request identity; verification detects a superseding policy',async()=>{
 let current=state;const key=crypto.randomUUID();const calls:{name:string;args?:Record<string,unknown>}[]=[];
 const db={rpc:async(name:string,args?:Record<string,unknown>)=>{calls.push({name,args});if(name==='worker_set_invitation_signing_key'){current={...state,key_id:'next',version:2};return {data:{key_id:'next',version:2,replayed:false},error:null};}return {data:current,error:null};}};
 assert.equal((await rotateInvitationSigning(db,{mode:'activate',target:'next',expected_policy_version:1,reference:'review-ref',request_key:key},env)).policy_version,2);assert.equal(calls[1].args?.p_key,key);
 current={...current,key_id:'later',version:3};assert.equal((await rotateInvitationSigning(db,{mode:'verify',target:'next'},env)).status,'BLOCKED');
});
test('operator SQL failures remain retryable and expose no transport or key details',async()=>{
 await assert.rejects(()=>rotateInvitationSigning({rpc:async()=>({data:null,error:{message:'sensitive transport text'}})},{mode:'plan',target:'next'},env),e=>(e as any).status===503&&!(e as Error).message.includes('sensitive'));
});
test('queued mail uses its recorded key and missing key stays retryable without cancellation or delivery',async()=>{
 const saved={...process.env};try{
  Object.assign(process.env,env,{INVITATION_MAIL_URL:'https://mail.example.test/',INVITATION_MAIL_TOKEN:'synthetic-mail',APP_URL:'https://app.example.test/'});
  const context={available:true,to:'synthetic@example.test',tenant_id:'tenant',actor_id:'actor',token_operation:'create:',request_key:'request',signing_key_id:'next',token_hash:tokenHash(invitationToken('b'.repeat(64),'tenant','actor','create:','request'))};let completed=0,delivered=0;
  const db={rpc:async(name:string,args?:Record<string,unknown>)=>{if(name==='worker_prepare_invitation_mail')return {data:context,error:null};completed++;assert.equal(args?.p_result,'EMAIL_ACCEPTED');return {data:{state:'SUCCEEDED'},error:null};}};
  await deliverQueuedInvitation(db,{id:'job',lease_token:'lease'},async(_to,link,key)=>{delivered++;assert.equal(new URL(link).hash,'#token='+invitationToken('b'.repeat(64),'tenant','actor','create:','request'));assert.equal(key,'invitation-mail:job');return 'EMAIL_ACCEPTED';});
  assert.equal(delivered,1);assert.equal(completed,1);process.env.INVITATION_TOKEN_KEYS='{}';await assert.rejects(()=>deliverQueuedInvitation(db,{id:'job',lease_token:'lease'},async()=>{delivered++;return 'EMAIL_ACCEPTED';}),e=>(e as any).status===503);assert.equal(delivered,1);assert.equal(completed,1);
 }finally{for(const name of Object.keys(process.env))if(!(name in saved))delete process.env[name];Object.assign(process.env,saved);}
});
test('invitation operator CLI requires explicit connection before reading any staging configuration',()=>{
 const script=fileURLToPath(new URL('../scripts/rotate-invitation-signing.mjs',import.meta.url));
 const help=spawnSync(process.execPath,['--experimental-strip-types',script,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/--staging-config/);assert.match(help.stdout,/--request-key/);
 const blocked=spawnSync(process.execPath,['--experimental-strip-types',script,'--mode','plan','--target','next','--staging-config','missing-private-config'],{encoding:'utf8'});assert.equal(blocked.status,1);assert.match(blocked.stderr,/BLOCKED/);assert.ok(!blocked.stderr.includes('ENOENT'));
});
