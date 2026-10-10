import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {intakeEncryptionKey,issueIntakeSecret,decryptIntakeSecret,encryptIntakeSecret} from '../src/server/intake-crypto.ts';
import {rotateIntakeEncryption,IntakeRotationError} from '../src/server/intake-key-rotation.ts';
import {intakeRotationSchema} from '../src/domain/intake-rotation.ts';
import {processSignedIntake} from '../src/server/signed-intake.ts';
import type {WorkerDb} from '../src/server/notification-worker.ts';
const env={INTAKE_ENCRYPTION_KEY:'a'.repeat(64),INTAKE_ENCRYPTION_KEYS:JSON.stringify({next:'b'.repeat(64),later:'c'.repeat(64)})};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const record=(id=crypto.randomUUID(),key='legacy')=>{const issued=issueIntakeSecret('synthetic:'+id,undefined,key,env);return {id,encryption_revision:1,encryption_key_id:key,secret_cipher:issued.cipher,secret_aad:issued.aad,secret_hash:issued.hash};};

test('AES key versions preserve exact signing derivation while changing encrypted storage',()=>{
 const a=issueIntakeSecret('retry:scope',undefined,'legacy',env),b=issueIntakeSecret('retry:scope',undefined,'next',env);assert.equal(a.secret,b.secret);assert.equal(a.hash,b.hash);assert.notEqual(a.cipher,b.cipher);assert.equal(decryptIntakeSecret(a.cipher,a.aad,undefined,'legacy',env),a.secret);assert.equal(decryptIntakeSecret(b.cipher,b.aad,undefined,'next',env),a.secret);assert.equal(decryptIntakeSecret(encryptIntakeSecret(a.secret,a.aad,'later',env),a.aad,undefined,'later',env),a.secret);
 assert.throws(()=>decryptIntakeSecret(b.cipher,b.aad,undefined,'legacy',env));assert.throws(()=>decryptIntakeSecret(b.cipher,'different',undefined,'next',env));
});
test('key ring rejects unknown IDs, malformed/private-conflicting inventory and short or mutated ciphertext',()=>{
 for(const value of ['[]','null','bad','{"legacy":"'+'a'.repeat(64)+'"}','{"constructor":"'+'b'.repeat(64)+'"}','{"next":"secret"}',JSON.stringify(Object.fromEntries(Array.from({length:11},(_,i)=>['k'+i,'b'.repeat(64)])))])assert.throws(()=>intakeEncryptionKey('legacy',{...env,INTAKE_ENCRYPTION_KEYS:value}));
 assert.throws(()=>intakeEncryptionKey('missing',env));assert.throws(()=>intakeEncryptionKey('__proto__',env));const r=record();assert.throws(()=>decryptIntakeSecret(r.secret_cipher+'00',r.secret_aad,undefined,'legacy',env));assert.throws(()=>decryptIntakeSecret('00',r.secret_aad,undefined,'legacy',env));assert.throws(()=>decryptIntakeSecret((r.secret_cipher[0]==='0'?'1':'0')+r.secret_cipher.slice(1),r.secret_aad,undefined,'legacy',env));
});
test('rotation controls require explicit reviewed versions/reference and bounded records',()=>{
 assert.ok(intakeRotationSchema.safeParse({mode:'plan',target:'next'}).success);assert.ok(intakeRotationSchema.safeParse({mode:'rewrap',target:'next',expected_policy_version:2,reference:'change-42'}).success);
 for(const extra of [{mode:'delete'},{mode:'activate'},{mode:'rewrap',reference:'change-42'},{max_records:24},{max_records:10001},{tenant_id:crypto.randomUUID()},{target:'../keys'}])assert.equal(intakeRotationSchema.safeParse({mode:'plan',target:'next',...extra}).success,false);
});
function fake(rows:ReturnType<typeof record>[],key='legacy'){
 let version=1;const calls:{name:string;args?:Record<string,unknown>}[]=[];
 const db:WorkerDb={rpc:async(name,args)=>{calls.push({name,args});if(name==='worker_intake_encryption_state')return {data:{key_id:key,version,counts:Object.fromEntries([...new Set(rows.map(r=>r.encryption_key_id))].map(k=>[k,rows.filter(r=>r.encryption_key_id===k).length]))},error:null};if(name==='worker_list_intake_encryption')return {data:rows.filter(r=>!args?.p_after||r.id>String(args.p_after)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,Number(args?.p_limit)),error:null};if(name==='worker_set_intake_encryption_key'){key=String(args?.p_target);version++;return {data:{key_id:key,version},error:null};}if(name==='worker_rewrap_intake_encryption'){const p=args?.p_payload as any,row=rows.find(r=>r.id===p.integration_id)!;row.secret_cipher=p.cipher;row.encryption_key_id=p.target_key_id;row.encryption_revision++;return {data:{encryption_key_id:row.encryption_key_id,encryption_revision:row.encryption_revision},error:null};}throw Error('Unknown fake call');}};
 return {db,calls};
}
test('dry plan verifies inactive/active envelope inventory without calling any write RPC or exposing secrets',async()=>{
 const rows=[record(),record(),record(crypto.randomUUID(),'next')],{db,calls}=fake(rows);const report=await rotateIntakeEncryption(db,{mode:'plan',target:'next',max_records:500},env);assert.equal(report.status,'READY');assert.equal(report.scanned,3);assert.equal(report.needs_rewrap,2);assert.equal(report.rewrapped,0);assert.equal(report.backup_key_retirement_approved,false);assert.ok(calls.every(c=>['worker_intake_encryption_state','worker_list_intake_encryption'].includes(c.name)));for(const row of rows){assert.ok(!JSON.stringify(report).includes(row.id));assert.ok(!JSON.stringify(report).includes(row.secret_cipher));assert.ok(!JSON.stringify(report).includes(row.secret_aad));}
});
test('missing/corrupt source keys block activation before any write and safe errors contain only progress',async()=>{
 for(const bad of [{...env,INTAKE_ENCRYPTION_KEY:'f'.repeat(64)},{...env,INTAKE_ENCRYPTION_KEYS:'{}'}]){const {db,calls}=fake([record()]);await assert.rejects(()=>rotateIntakeEncryption(db,{mode:'activate',target:'next',expected_policy_version:1,reference:'change-42',max_records:500},bad),e=>e instanceof IntakeRotationError&&e.report.rewrapped===0&&!JSON.stringify(e.report).includes('synthetic'));assert.ok(!calls.some(c=>c.name.startsWith('worker_set')||c.name.startsWith('worker_rewrap')));}
 const row=record();row.secret_hash='f'.repeat(64);const f=fake([row]);await assert.rejects(()=>rotateIntakeEncryption(f.db,{mode:'activate',target:'next',expected_policy_version:1,reference:'change-42',max_records:500},env),e=>e instanceof IntakeRotationError&&e.code==='INTAKE_ROTATION_INVALID_CREDENTIAL');assert.ok(!f.calls.some(c=>c.name==='worker_set_intake_encryption_key'));
});
test('bounded preflight cannot activate or rewrite a partially scanned inventory',async()=>{
 const {db,calls}=fake(Array.from({length:26},()=>record()));const r=await rotateIntakeEncryption(db,{mode:'activate',target:'next',expected_policy_version:1,reference:'change-42',max_records:25},env);assert.equal(r.status,'INCOMPLETE');assert.equal(r.scanned,25);assert.equal(r.complete_inventory,false);assert.ok(!calls.some(c=>c.name==='worker_set_intake_encryption_key'));
});
test('activation and rewrap are separate operations; verify checks remaining key references',async()=>{
 const rows=[record(),record()],f=fake(rows);let r=await rotateIntakeEncryption(f.db,{mode:'activate',target:'next',expected_policy_version:1,reference:'change-42',max_records:500},env);assert.equal(r.policy_version,2);assert.equal(r.rewrapped,0);assert.equal(r.live_rewrap_complete,false);
 assert.equal((await rotateIntakeEncryption(f.db,{mode:'verify',target:'next',max_records:500},env)).status,'INCOMPLETE');r=await rotateIntakeEncryption(f.db,{mode:'rewrap',target:'next',expected_policy_version:2,reference:'change-42',max_records:500},env);assert.equal(r.rewrapped,2);assert.equal(r.live_rewrap_complete,true);assert.equal((await rotateIntakeEncryption(f.db,{mode:'verify',target:'next',max_records:500},env)).status,'READY');assert.equal((await rotateIntakeEncryption(f.db,{mode:'rewrap',target:'next',expected_policy_version:2,reference:'change-42',max_records:500},env)).rewrapped,0);
 for(const row of rows)assert.equal(digest(decryptIntakeSecret(row.secret_cipher,row.secret_aad,undefined,'next',env)),row.secret_hash);
});
test('network loss retries the exact mutation payload/key; version conflicts stop without retry or secret logs',async()=>{
 const f=fake([record()],'next'),base=f.db.rpc;let lost=false,first:any;
 f.db.rpc=async(name,args)=>{if(name==='worker_rewrap_intake_encryption'&&!lost){lost=true;first=structuredClone(args);await base(name,args);throw Error('SECRET_TRANSPORT_BODY');}if(name==='worker_rewrap_intake_encryption'){assert.deepEqual(args,first);return {data:{encryption_key_id:'next',encryption_revision:2,replayed:true},error:null};}return base(name,args);};
 assert.equal((await rotateIntakeEncryption(f.db,{mode:'rewrap',target:'next',expected_policy_version:1,reference:'change-42',max_records:500},env)).rewrapped,1);
 const c=fake([record()],'next');let writes=0;const original=c.db.rpc;c.db.rpc=async(name,args)=>{if(name==='worker_rewrap_intake_encryption'){writes++;return {data:null,error:{message:'VERSION_CONFLICT'}};}return original(name,args);};await assert.rejects(()=>rotateIntakeEncryption(c.db,{mode:'rewrap',target:'next',expected_policy_version:1,reference:'change-42',max_records:500},env),e=>e instanceof IntakeRotationError&&e.code==='VERSION_CONFLICT');assert.equal(writes,1);
});
test('nonmonotonic/duplicate private pages cannot cause duplicate processing',async()=>{
 const row=record(),f=fake([row]);f.db.rpc=async(name)=>name==='worker_intake_encryption_state'?{data:{key_id:'legacy',version:1,counts:{legacy:2}},error:null}:{data:[row,row],error:null};await assert.rejects(()=>rotateIntakeEncryption(f.db,{mode:'plan',target:'next',max_records:500},env),e=>e instanceof IntakeRotationError&&e.code==='INTAKE_ROTATION_INVALID_PAGE');
});
test('a policy change after the last acknowledgement blocks final readiness',async()=>{
 const f=fake([record(crypto.randomUUID(),'next')],'next'),base=f.db.rpc;let reads=0;
 f.db.rpc=async(name,args)=>{const result=await base(name,args);if(name==='worker_intake_encryption_state'&&++reads===3)result.data={...result.data,version:2,key_id:'later'};return result;};
 await assert.rejects(()=>rotateIntakeEncryption(f.db,{mode:'verify',target:'next',max_records:500},env),e=>e instanceof IntakeRotationError&&e.code==='INTAKE_KEY_POLICY_CONFLICT'&&e.report.status==='BLOCKED');
});
test('existing website signature continues working after envelope rewrap; no new site signing key is introduced',async()=>{
 const row=record(),secret=decryptIntakeSecret(row.secret_cipher,row.secret_aad,undefined,'legacy',env),cipher=encryptIntakeSecret(secret,row.secret_aad,'next',env);
 const old=process.env.INTAKE_ENCRYPTION_KEY,ring=process.env.INTAKE_ENCRYPTION_KEYS;try{process.env.INTAKE_ENCRYPTION_KEY=env.INTAKE_ENCRYPTION_KEY;process.env.INTAKE_ENCRYPTION_KEYS=env.INTAKE_ENCRYPTION_KEYS;
 const timestamp=String(Math.floor(Date.now()/1000)),body=JSON.stringify({external_event_id:'key-drill-1',lead:{full_name:'Synthetic signature',email:'synthetic@example.test'}}),signature=createHmac('sha256',secret).update(timestamp+'.').update(body).digest('hex');
 const db:WorkerDb={rpc:async(name)=>({data:name==='worker_intake_credential'?{secret_cipher:cipher,secret_aad:row.secret_aad,secret_hash:row.secret_hash,key_version:7,encryption_key_id:'next'}:name==='worker_intake_limit'?{allowed:true}:{id:'synthetic-lead'},error:null})};
 assert.equal((await processSignedIntake(new Request('https://app.example.test',{method:'POST',headers:{'Content-Type':'application/json','X-Intake-Timestamp':timestamp,'X-Intake-Signature':signature},body}),row.id,db,crypto.randomUUID())).id,'synthetic-lead');
 }finally{if(old===undefined)delete process.env.INTAKE_ENCRYPTION_KEY;else process.env.INTAKE_ENCRYPTION_KEY=old;if(ring===undefined)delete process.env.INTAKE_ENCRYPTION_KEYS;else process.env.INTAKE_ENCRYPTION_KEYS=ring;}
});
test('operator command help/no-connect paths do not read staging configuration or initiate a connection',()=>{
 const script=fileURLToPath(new URL('../scripts/rotate-intake-encryption.mjs',import.meta.url)),help=spawnSync(process.execPath,['--experimental-strip-types',script,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/No connection without/);
 const blocked=spawnSync(process.execPath,['--experimental-strip-types',script,'--mode','activate','--target','next','--staging-config','definitely-missing.env'],{encoding:'utf8'});assert.equal(blocked.status,1);assert.match(blocked.stderr,/BLOCKED/);assert.ok(!blocked.stderr.includes('ENOENT'));
});
