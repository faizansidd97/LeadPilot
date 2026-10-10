import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {parseEnv} from './local-evidence.mjs';
import {intakeRotationSchema} from '../src/domain/intake-rotation.ts';
import {rotateIntakeEncryption,IntakeRotationError} from '../src/server/intake-key-rotation.ts';
const usage='Intake AES operations: --mode plan|activate|rewrap|verify --target KEY_ID --connect-staging [--staging-config PATH] [--expected-policy-version N --reference CHANGE_REFERENCE] [--max-records 25..10000].\nNo connection without --connect-staging. activate/rewrap require a reviewed policy version and change reference. Reads/writes use narrow worker RPCs only. No key values or encrypted credentials are printed. Legacy derivation and backup keys still require preservation.';
try{
 const {values}=parseArgs({options:{help:{type:'boolean'},mode:{type:'string'},target:{type:'string'},'connect-staging':{type:'boolean'},'staging-config':{type:'string'},'expected-policy-version':{type:'string'},reference:{type:'string'},'max-records':{type:'string'}},strict:true,allowPositionals:false});
 if(values.help){console.log(usage);}else{
  if(!values['connect-staging'])throw Error('CONNECT_REQUIRED');
  const parsed=intakeRotationSchema.safeParse({mode:values.mode,target:values.target,expected_policy_version:values['expected-policy-version']===undefined?undefined:Number(values['expected-policy-version']),reference:values.reference,max_records:values['max-records']===undefined?undefined:Number(values['max-records'])});if(!parsed.success)throw Error('INVALID_OPTIONS');
  const env=values['staging-config']?parseEnv(await readFile(values['staging-config'],'utf8')):process.env;
  const url=env.NEXT_PUBLIC_SUPABASE_URL,key=env.SUPABASE_SERVICE_ROLE_KEY;let valid=false;
  try{const base=new URL(url);valid=base.protocol==='https:'&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname);if(!key?.startsWith('sb_secret_')&&JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role!=='service_role')valid=false;}catch{valid=false;}
  if(!valid||!key)throw Error('CONFIGURATION_REQUIRED');
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})}});
  const report=await rotateIntakeEncryption({rpc:async(name,args)=>{const result=await client.rpc(name,args);return {data:result.data,error:result.error};}},parsed.data,env);
  console.log(JSON.stringify(report,null,2));if(report.status!=='READY')process.exitCode=1;
 }
}catch(error){
 if(error instanceof IntakeRotationError)console.error(JSON.stringify({error:error.code,...error.report},null,2));
 else console.error(JSON.stringify({status:'BLOCKED',message:'Check explicit connection flag, rotation options, private staging configuration and key inventory. No secret/error text is printed.'}));
 process.exitCode=1;
}
