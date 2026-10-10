import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {preparedProviderRequestId,aiAttemptDiagnosticsSchema} from '../src/domain/ai-attempts.ts';
import {readAiAttemptDiagnostics} from '../src/server/ai-attempt-diagnostics.ts';
import {runAnalyses} from '../src/server/analysis-worker.ts';
import {runDrafts} from '../src/server/draft-worker.ts';
import {fixtures,emptyAnalysis} from './analysis-fixtures.ts';
const job=crypto.randomUUID(),requestId=crypto.randomUUID();
const report=()=>({job_id:job,kind:'ANALYSIS',job_version:3,state:'FAILED',usage_state:'RECONCILE',uncertain_usage:true,
 observed_tokens:17,reserved_tokens:100,claim_attempts:2,claims_without_prepare_record:1,
 attempts:[{claim_attempt:2,provider_request_id:requestId,prepared_at:new Date().toISOString()}],provider_usage_verified:false,resolution_available:false});
test('diagnostic contract preserves partial/legacy history and refuses hidden fields or billing claims',()=>{
 assert.ok(aiAttemptDiagnosticsSchema.safeParse(report()).success);
 assert.ok(aiAttemptDiagnosticsSchema.safeParse({...report(),attempts:[],claims_without_prepare_record:2}).success);
 for(const value of [{...report(),payload:'PRIVATE'}, {...report(),claims_without_prepare_record:0},
  {...report(),claim_attempts:1}, {...report(),provider_usage_verified:true}, {...report(),resolution_available:true},
  {...report(),observed_tokens:-1}, {...report(),reserved_tokens:0.5},
  {...report(),attempts:[report().attempts[0],report().attempts[0]],claims_without_prepare_record:0}])assert.equal(aiAttemptDiagnosticsSchema.safeParse(value).success,false);
});
test('prepared request identity is strict and has no random fallback',()=>{
 assert.equal(preparedProviderRequestId({provider_request_id:requestId}),requestId);
 for(const value of [undefined,null,'PRIVATE','not-a-uuid'])assert.throws(()=>preparedProviderRequestId({provider_request_id:value}),error=>{
  assert.equal((error as any).code,'TRANSIENT_DATABASE_FAILURE');assert.equal((error as any).tokens,0);return true;
 });
});
test('operator read is one narrow RPC and rejects cross-job, private and malformed responses',async()=>{
 let calls=0;
 const actual=await readAiAttemptDiagnostics({rpc:async(name,args)=>{calls++;assert.equal(name,'worker_ai_attempt_diagnostics');assert.deepEqual(args,{p_job:job});return {data:report(),error:null};}},job);
 assert.equal(actual.attempts[0].provider_request_id,requestId);assert.equal(calls,1);
 for(const data of [{...report(),job_id:crypto.randomUUID()}, {...report(),private:'PRIVATE'},null]){
  await assert.rejects(readAiAttemptDiagnostics({rpc:async()=>({data,error:null})},job),/Private attempt diagnostics are unavailable/);
 }
 await assert.rejects(readAiAttemptDiagnostics({rpc:async()=>({data:null,error:{message:'PRIVATE'}})},job),error=>!String(error).includes('PRIVATE'));
 calls=0;await assert.rejects(readAiAttemptDiagnostics({rpc:async()=>{calls++;return {data:report(),error:null};}},'INVALID'));assert.equal(calls,0);
});
for(const kind of ['ANALYSIS','DRAFT'] as const){
 const run=async(db:any,provider:any)=>kind==='ANALYSIS'
  ? runAnalyses(db,{enabled:true,key:'PRIVATE',model:'fixture',languages:['en']},provider)
  : runDrafts(db,{enabled:true,base:{enabled:true,key:'PRIVATE',model:'fixture',languages:['en']}},provider);
 const dbFor=(id:unknown)=>{
  let claims=0;const calls:{name:string;args:any}[]=[];
  return {calls,rpc:async(name:string,args:any)=>{calls.push({name,args});
   if(name===(kind==='ANALYSIS'?'worker_claim_analysis':'worker_claim_draft'))return {data:claims++===0?{id:job,lease_token:crypto.randomUUID()}:null,error:null};
   if(name.startsWith('worker_prepare_'))return {data:{provider_request_id:id,snapshot:{...fixtures[0].snapshot,draft_options:{language:'en',tone:'PROFESSIONAL',instruction:''}},model:'fixture',languages:['en']},error:null};
   return {data:{state:'FAILED'},error:null};
  }};
 };
 test(kind+' worker sends the recorded correlation ID and retains observed usage on rejected output',async()=>{
  const db=dbFor(requestId);let sent=0;
  const provider=async(...args:any[])=>{sent++;assert.equal(args.at(-1),requestId);return {analysis:kind==='ANALYSIS'?{...emptyAnalysis(),summary:'PRIVATE_INVENTED'}:{schema_version:'draft-1',language:'en',tone:'PROFESSIONAL',blocks:['CLAIM_AVAILABILITY'],evidence:[]},tokens:42};};
  const result=await run(db,provider);assert.equal(sent,1);const failure=db.calls.find(c=>c.name==='worker_fail_analysis')!;
  assert.equal(failure.args.p_tokens,42);assert.equal(failure.args.p_uncertain,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|provider_request_id/);
 });
 test(kind+' worker refuses untracked provider calls before dispatch and reports a known zero-token failure',async()=>{
  for(const id of [undefined,'MALFORMED']){const db=dbFor(id);let sent=0;
   await run(db,async()=>{sent++;throw Error('MUST_NOT_CALL');});assert.equal(sent,0);
   const failure=db.calls.find(c=>c.name==='worker_fail_analysis')!;assert.equal(failure.args.p_tokens,0);assert.equal(failure.args.p_uncertain,false);assert.equal(failure.args.p_code,'TRANSIENT_DATABASE_FAILURE');
  }
 });
 test(kind+' provider transport loss keeps unknown usage while using a persisted ID',async()=>{
  const db=dbFor(requestId);await run(db,async(...args:any[])=>{assert.equal(args.at(-1),requestId);throw Error('PRIVATE_TRANSPORT_LOSS');});
  const failure=db.calls.find(c=>c.name==='worker_fail_analysis')!;assert.equal(failure.args.p_tokens,null);assert.equal(failure.args.p_uncertain,true);
 });
}
test('attempt CLI help/blocked paths do not read config, connect or reflect secrets',()=>{
 const script=fileURLToPath(new URL('../scripts/inspect-ai-attempts.mjs',import.meta.url));
 for(const args of [['--help','--staging-config','MISSING_PRIVATE_FILE'],['--job',job,'--staging-config','MISSING_PRIVATE_FILE'],['--connect-staging','--job',job]]){
  const result=spawnSync(process.execPath,['--experimental-strip-types',script,...args],{encoding:'utf8',windowsHide:true,
   env:{...process.env,NEXT_PUBLIC_SUPABASE_URL:'https://localhost',SUPABASE_SERVICE_ROLE_KEY:'PRIVATE_WORKER_SECRET'}});
  assert.equal(result.status,args[0]==='--help'?0:1);assert.doesNotMatch(result.stdout+result.stderr,/PRIVATE_WORKER_SECRET|MISSING_PRIVATE_FILE|ENOENT|fetch failed/);
 }
});
