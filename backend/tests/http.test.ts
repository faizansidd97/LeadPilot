import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api,ApiError,checkOrigin,readJson,databaseError } from '../src/server/http.ts';
import { decodeCursor,agencySchema,validate } from '../src/domain/contracts.ts';
import { updateLeadSchema } from '../src/domain/lead-update.ts';
test('cookie mutations require same origin',()=>{
 assert.throws(()=>checkOrigin(new Request('http://localhost:4000/api',{headers:{origin:'https://attacker.example'}})),/origin/);
 assert.throws(()=>checkOrigin(new Request('http://localhost:4000/api')),/origin/);
 assert.doesNotThrow(()=>checkOrigin(new Request('http://localhost:4000/api',{headers:{origin:'http://localhost:4000'}})));
});
test('request body parser rejects invalid, oversized and non-JSON inputs',async()=>{
 await assert.rejects(()=>readJson(new Request('http://localhost:4000',{method:'POST',body:'{}'})),/application\/json/);
 await assert.rejects(()=>readJson(new Request('http://localhost:4000',{method:'POST',body:'bad',headers:{'Content-Type':'application/json'}})),/valid JSON/);
 await assert.rejects(()=>readJson(new Request('http://localhost:4000',{method:'POST',body:'"oversized"',headers:{'Content-Type':'application/json'}}),4),/exceeds/);
});
test('errors never expose raw secrets or database text and disable caching',async()=>{
 const response=await api(async()=>{throw new Error('SECRET_DATABASE_PASSWORD');});assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal((await response.text()).includes('SECRET_DATABASE_PASSWORD'),false);
 assert.throws(()=>databaseError({message:'VERSION_CONFLICT'}),(e:unknown)=>e instanceof ApiError&&e.status===409);
});
test('agency timezone, update versions and cursors are validated',()=>{
 assert.throws(()=>validate(agencySchema,{name:'Agency',timezone:'Invalid/Timezone'}),/highlighted/);
 assert.throws(()=>decodeCursor(Buffer.from('{"created_at":"x,evil","id":"fake"}').toString('base64url')),/invalid/);
 assert.equal(updateLeadSchema.safeParse({full_name:'Buyer',email:'buyer@example.com',expected_version:0}).success,false);
 assert.equal(updateLeadSchema.safeParse({full_name:'Buyer',email:'buyer@example.com',expected_version:1,tenant_id:'fake'}).success,false);
});
