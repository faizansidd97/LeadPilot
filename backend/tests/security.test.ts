import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contentSecurityPolicy,securityRequestHeaders,browserSecurityHeaders,appOrigin} from '../src/server/security.ts';
import {api,ApiError,checkOrigin,databaseError} from '../src/server/http.ts';
import {privacyRequestSchema,privacyActionSchema} from '../src/domain/privacy.ts';

test('production script CSP uses unpredictable request nonces and blocks inline handlers, frames and eval',()=>{
 const a=securityRequestHeaders(new Headers({'x-nonce':'attacker','Content-Security-Policy':"script-src * 'unsafe-inline'"})),b=securityRequestHeaders(new Headers());
 assert.notEqual(a.nonce,b.nonce);assert.equal(Buffer.from(a.nonce,'base64').length,18);assert.equal(a.headers.get('x-nonce'),a.nonce);assert.equal(a.headers.get('Content-Security-Policy'),a.csp);
 const script=a.csp.split('; ').find(v=>v.startsWith('script-src '))!;assert.ok(script.includes("'nonce-"+a.nonce+"'"));assert.ok(script.includes("'strict-dynamic'"));assert.ok(!script.includes('unsafe-inline')&&!script.includes('unsafe-eval'));
 for(const directive of ["script-src-attr 'none'","object-src 'none'","frame-ancestors 'none'","base-uri 'none'","form-action 'self'","connect-src 'self'"])assert.ok(a.csp.includes(directive));
 assert.throws(()=>contentSecurityPolicy("bad'; script-src *"),/INVALID_NONCE/);
});
test('development eval/socket and inline-style compatibility are explicit and do not relax production scripts',()=>{
 const nonce=Buffer.alloc(18,1).toString('base64'),dev=contentSecurityPolicy(nonce,true),prod=contentSecurityPolicy(nonce);
 assert.ok(dev.includes("'unsafe-eval'")&&dev.includes('ws: wss:'));assert.ok(!prod.includes('ws:')&&!prod.includes('unsafe-eval'));assert.ok(prod.includes("style-src 'self' 'unsafe-inline'"));
});
test('security headers forbid framing, sniffing and referrer leaks; HSTS applies only to production HTTPS',()=>{
 const local=browserSecurityHeaders({development:true,https:false}),prod=browserSecurityHeaders({https:true});assert.equal(local['X-Frame-Options'],'DENY');assert.equal(local['X-Content-Type-Options'],'nosniff');assert.equal(local['Referrer-Policy'],'no-referrer');assert.equal(local['Strict-Transport-Security'],undefined);assert.equal(browserSecurityHeaders({https:false})['Strict-Transport-Security'],undefined);assert.equal(browserSecurityHeaders({development:true,https:true})['Strict-Transport-Security'],undefined);assert.equal(prod['Strict-Transport-Security'],'max-age=31536000');
});
test('production origins fail closed for missing, insecure, credential-bearing or nonbase configuration',()=>{
 const url='https://app.example.test/api';assert.equal(appOrigin(url,{NODE_ENV:'production',APP_URL:'https://app.example.test/'}),'https://app.example.test');
 for(const APP_URL of [undefined,'http://app.example.test','https://user:secret@app.example.test','https://app.example.test/path','https://app.example.test/?x=1','https://app.example.test/#x','http://localhost:4000'])assert.throws(()=>appOrigin(url,{NODE_ENV:'production',APP_URL}),e=>e instanceof ApiError&&e.status===503);
 assert.equal(appOrigin('http://localhost:4000/api',{NODE_ENV:'development'}),'http://localhost:4000');
});
test('origin checks reject cross-site, spoofed subdomains and invalid production configuration',()=>{
 const prior={APP_URL:process.env.APP_URL,NODE_ENV:process.env.NODE_ENV};try{
  process.env.NODE_ENV='production';process.env.APP_URL='https://app.example.test';
  assert.doesNotThrow(()=>checkOrigin(new Request('https://app.example.test/api',{headers:{origin:'https://app.example.test','sec-fetch-site':'same-origin'}})));
  for(const headers of [{origin:'https://app.example.test.evil'},{origin:'https://app.example.test','sec-fetch-site':'cross-site'},{}] as Record<string,string>[])assert.throws(()=>checkOrigin(new Request('https://app.example.test/api',{headers})),e=>e instanceof ApiError&&e.status===403);
  delete process.env.APP_URL;assert.throws(()=>checkOrigin(new Request('https://app.example.test/api',{headers:{origin:'https://app.example.test'}})),e=>e instanceof ApiError&&e.status===503);
 }finally{for(const [k,v] of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
test('operational logging contains only fixed timing/status metadata and matching generated request ID',async()=>{
 const saved=process.env.OPERATIONAL_LOGS_ENABLED,log=console.info,rows:string[]=[];try{
  process.env.OPERATIONAL_LOGS_ENABLED='true';console.info=v=>rows.push(v);
  const response=await api(async()=>{throw Error('PRIVATE_BODY_SECRET');});assert.equal(response.status,503);const data=JSON.parse(rows[0]);assert.deepEqual(Object.keys(data).sort(),['duration_ms','event','request_id','status']);assert.equal(data.request_id,response.headers.get('x-request-id'));assert.equal(data.status,503);assert.ok(data.duration_ms>=0);assert.ok(!rows.join('').includes('PRIVATE_BODY_SECRET'));
  process.env.OPERATIONAL_LOGS_ENABLED='false';await api(async()=>({private:'not logged'}));assert.equal(rows.length,1);
 }finally{console.info=log;if(saved===undefined)delete process.env.OPERATIONAL_LOGS_ENABLED;else process.env.OPERATIONAL_LOGS_ENABLED=saved;}
});
test('privacy contracts accept intake/triage only and reject authority injection, execution and invalid versions',()=>{
 const input={kind:'LEAD_ERASURE',lead_id:crypto.randomUUID(),expected_version:1,reason:'Customer request'};
 assert.ok(privacyRequestSchema.safeParse(input).success);assert.ok(privacyRequestSchema.safeParse({...input,kind:'AGENCY_CLOSURE',lead_id:null}).success);
 for(const extra of [{tenant_id:crypto.randomUUID()},{actor_id:crypto.randomUUID()},{approved:true},{expected_version:0},{expected_version:1.5},{expected_version:2147483648},{lead_id:null}])assert.equal(privacyRequestSchema.safeParse({...input,...extra}).success,false);
 for(const action of ['PURGE','APPROVE','ANONYMIZE','CLOSE_AGENCY'])assert.equal(privacyActionSchema.safeParse({action,expected_version:1,reason:'Reviewed request'}).success,false);
 assert.equal(privacyActionSchema.safeParse({action:'REVIEW',expected_version:1,reason:'Reviewed request'}).success,false);assert.equal(privacyActionSchema.safeParse({action:'REVIEW',expected_version:1,reason:'Reviewed request',verification_reference:'case-123'}).success,true);
 assert.throws(()=>databaseError({message:'PRIVACY_CASE_EXISTS'}),e=>e instanceof ApiError&&e.status===409);
});
