import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {intakeSigningRootKey,issueIntakeSecret,decryptIntakeSecret,encryptIntakeSecret} from '../src/server/intake-crypto.ts';
import {intakeRootRotationSchema,rotateIntakeSigningRoot} from '../src/server/intake-root-rotation.ts';
const env={INTAKE_ENCRYPTION_KEY:'a'.repeat(64),INTAKE_ENCRYPTION_KEYS:JSON.stringify({aes:'b'.repeat(64)}),INTAKE_SIGNING_ROOT_KEYS:JSON.stringify({next:'c'.repeat(64),later:'d'.repeat(64)})};
const state={key_id:'legacy',version:1,issuance_counts:{legacy:2},encryption_key_id:'legacy',key_retirement_approved:false};
test('intake legacy derivation remains byte compatible and signing roots are independent of AES storage keys',()=>{
 const scope='tenant:actor:create:request',legacy=issueIntakeSecret(scope,undefined,'legacy',env),rewrapped=issueIntakeSecret(scope,undefined,'aes',env);
 assert.equal(legacy.secret,createHmac('sha256',Buffer.from(env.INTAKE_ENCRYPTION_KEY,'hex')).update('leadpilot-intake-v1:'+scope).digest('hex'));assert.equal(legacy.secret,rewrapped.secret);assert.equal(legacy.signing_root_id,'legacy');
 const fresh=issueIntakeSecret(scope,undefined,'aes',env,'next');assert.notEqual(fresh.secret,legacy.secret);assert.equal(fresh.signing_root_id,'next');assert.equal(decryptIntakeSecret(fresh.cipher,fresh.aad,undefined,'aes',env),fresh.secret);assert.equal(fresh.secret,issueIntakeSecret(scope,undefined,'legacy',env,'next').secret);
});
test('named intake roots and named AES storage can issue without a legacy root; legacy retries still fail if missing',()=>{
 const onlyNamed={INTAKE_ENCRYPTION_KEYS:env.INTAKE_ENCRYPTION_KEYS,INTAKE_SIGNING_ROOT_KEYS:env.INTAKE_SIGNING_ROOT_KEYS};assert.equal(issueIntakeSecret('named:scope',undefined,'aes',onlyNamed,'next').signing_root_id,'next');assert.throws(()=>issueIntakeSecret('legacy:scope',undefined,'aes',onlyNamed),/configured/);assert.throws(()=>intakeSigningRootKey('aes',env),/configured/);
});
test('intake roots reject missing, malformed, inherited, legacy override and unbounded inventory without secrets',()=>{
 for(const ring of ['[]','null','bad',JSON.stringify({legacy:'c'.repeat(64)}),'{"__proto__":"'+ 'c'.repeat(64)+'"}',JSON.stringify({constructor:'c'.repeat(64)}),JSON.stringify({next:'C'.repeat(64)}),JSON.stringify(Object.fromEntries(Array.from({length:11},(_,i)=>['r'+i,'c'.repeat(64)])))])assert.throws(()=>intakeSigningRootKey('legacy',{...env,INTAKE_SIGNING_ROOT_KEYS:ring}),e=>(e as any).status===503&&!(e as Error).message.includes(env.INTAKE_ENCRYPTION_KEY));
 for(const id of ['missing','constructor','prototype','__proto__','Next'])assert.throws(()=>intakeSigningRootKey(id,env));
});
test('signing credential rewrap preserves the derived key without needing any derivation root',()=>{
 const issued=issueIntakeSecret('synthetic:scope',undefined,'legacy',env,'next');const cipher=encryptIntakeSecret(issued.secret,issued.aad,'aes',env);assert.equal(decryptIntakeSecret(cipher,issued.aad,undefined,'aes',{INTAKE_ENCRYPTION_KEYS:env.INTAKE_ENCRYPTION_KEYS}),issued.secret);
});
test('root activation requires reviewed version, reference and stable UUID; unsupported automatic reissue is rejected',()=>{
 assert.equal(intakeRootRotationSchema.safeParse({mode:'plan',target:'next'}).success,true);
 for(const options of [{mode:'activate',target:'next'},{mode:'activate',target:'next',reference:'ref-17',expected_policy_version:1}, {mode:'activate',target:'next',reference:'ref-17',expected_policy_version:0,request_key:crypto.randomUUID()}, {mode:'rewrap',target:'next'}, {mode:'plan',target:'next',secret:'injection'}])assert.equal(intakeRootRotationSchema.safeParse(options).success,false);
});
test('root preflight validates every retained root and active AES key before any mutation',async()=>{
 const calls:string[]=[];const db={rpc:async(name:string)=>{calls.push(name);return {data:state,error:null};}};
 const report=await rotateIntakeSigningRoot(db,{mode:'plan',target:'next'},env);assert.equal(report.status,'READY');assert.equal(report.key_retirement_approved,false);assert.equal(report.fleet_readiness_verified,false);assert.ok(!JSON.stringify(report).includes(env.INTAKE_ENCRYPTION_KEY));assert.deepEqual(calls,['worker_intake_signing_state']);
 const opts={mode:'activate' as const,target:'next',expected_policy_version:1,reference:'ref-17',request_key:crypto.randomUUID()};await assert.rejects(()=>rotateIntakeSigningRoot(db,opts,{INTAKE_SIGNING_ROOT_KEYS:env.INTAKE_SIGNING_ROOT_KEYS}));await assert.rejects(()=>rotateIntakeSigningRoot({rpc:async(name:string)=>{calls.push(name);return {data:{...state,key_id:'next',encryption_key_id:'aes'},error:null};}},opts,{INTAKE_ENCRYPTION_KEY:env.INTAKE_ENCRYPTION_KEY,INTAKE_SIGNING_ROOT_KEYS:env.INTAKE_SIGNING_ROOT_KEYS}));assert.ok(calls.every(n=>n==='worker_intake_signing_state'));
});
test('root activation reuses operation identity and verification detects a later active policy',async()=>{
 let current=state;const key=crypto.randomUUID();const db={rpc:async(name:string,args?:Record<string,unknown>)=>{if(name==='worker_set_intake_signing_root'){assert.equal(args?.p_key,key);current={...state,key_id:'next',version:2};return {data:{key_id:'next',version:2,replayed:false},error:null};}return {data:current,error:null};}};
 assert.equal((await rotateIntakeSigningRoot(db,{mode:'activate',target:'next',expected_policy_version:1,reference:'ref-17',request_key:key},env)).policy_version,2);current={...current,key_id:'later',version:3};assert.equal((await rotateIntakeSigningRoot(db,{mode:'verify',target:'next'},env)).status,'BLOCKED');
 await assert.rejects(()=>rotateIntakeSigningRoot({rpc:async()=>({data:null,error:{message:'SECRET_DIAGNOSTIC'}})},{mode:'plan',target:'next'},env),e=>(e as any).status===503&&!(e as Error).message.includes('SECRET_DIAGNOSTIC'));
});
test('root operator help/no-connect never reads private staging configuration or initiates a connection',()=>{
 const script=fileURLToPath(new URL('../scripts/rotate-intake-signing-root.mjs',import.meta.url));const help=spawnSync(process.execPath,['--experimental-strip-types',script,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/--request-key/);assert.match(help.stdout,/--staging-config/);
 const blocked=spawnSync(process.execPath,['--experimental-strip-types',script,'--mode','activate','--target','next','--staging-config','missing-private.env'],{encoding:'utf8'});assert.equal(blocked.status,1);assert.match(blocked.stderr,/BLOCKED/);assert.ok(!blocked.stderr.includes('ENOENT'));
});
