import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {parseEnv} from './local-evidence.mjs';
import {intakeRootRotationSchema,rotateIntakeSigningRoot} from '../src/server/intake-root-rotation.ts';
const usage='Intake signing-root operations: --mode plan|activate|verify --target KEY_ID --connect-staging [--staging-config PATH]. Activation additionally requires --expected-policy-version N --reference CHANGE_REFERENCE --request-key UUID (reuse on transport retry).\nNo connection without --connect-staging. Deploy complete immutable root and AES key mappings to every API/worker replica before activation. Preserve legacy/retained roots and AES keys and backup dependencies. No raw keys, signing credentials or customer data are printed.';
try{
 const {values}=parseArgs({options:{help:{type:'boolean'},mode:{type:'string'},target:{type:'string'},'connect-staging':{type:'boolean'},'staging-config':{type:'string'},'expected-policy-version':{type:'string'},reference:{type:'string'},'request-key':{type:'string'}},strict:true,allowPositionals:false});
 if(values.help)console.log(usage);else{
  if(!values['connect-staging'])throw Error('CONNECT_REQUIRED');
  const input=intakeRootRotationSchema.parse({mode:values.mode,target:values.target,expected_policy_version:values['expected-policy-version']===undefined?undefined:Number(values['expected-policy-version']),reference:values.reference,request_key:values['request-key']});
  const env=values['staging-config']?parseEnv(await readFile(values['staging-config'],'utf8')):process.env;
  const url=env.NEXT_PUBLIC_SUPABASE_URL,key=env.SUPABASE_SERVICE_ROLE_KEY;let valid=false;
  try{const base=new URL(url);valid=base.protocol==='https:'&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname);if(!key?.startsWith('sb_secret_')&&JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role!=='service_role')valid=false;}catch{valid=false;}
  if(!valid||!key)throw Error('CONFIGURATION_REQUIRED');
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})}});
  const report=await rotateIntakeSigningRoot({rpc:async(name,args)=>{const result=await client.rpc(name,args);return {data:result.data,error:result.error};}},input,env);
  console.log(JSON.stringify(report,null,2));if(report.status!=='READY')process.exitCode=1;
 }
}catch{console.error(JSON.stringify({status:'BLOCKED',message:'Check connection flag, options, retained key inventory and private staging configuration. Reuse the activation request key on retry. No secret/error text is printed.'}));process.exitCode=1;}
