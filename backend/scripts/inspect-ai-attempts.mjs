import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {parseEnv} from './local-evidence.mjs';
import {readAiAttemptDiagnostics} from '../src/server/ai-attempt-diagnostics.ts';
const usage='Private read-only AI attempt diagnostics: --job UUID --connect-staging [--staging-config PATH].\nNo config-file read or connection without the explicit flag. Requires HTTPS staging project URL and private worker key. Reports opaque job/request IDs and bounded usage/attempt metadata only. No customer context, leases, keys, raw errors, provider calls, retries, refunds or reconciliation writes. Prepared requests are not proof of dispatch, provider dedupe or verified billing.';
try{
 const {values}=parseArgs({options:{help:{type:'boolean'},job:{type:'string'},'connect-staging':{type:'boolean'},'staging-config':{type:'string'}},strict:true,allowPositionals:false});
 if(values.help)console.log(usage);else{
  if(!values['connect-staging'])throw Error('CONNECT_REQUIRED');
  const job=z.uuid().parse(values.job);
  const env=values['staging-config']?parseEnv(await readFile(values['staging-config'],'utf8')):process.env;
  const url=env.NEXT_PUBLIC_SUPABASE_URL,key=env.SUPABASE_SERVICE_ROLE_KEY;let valid=false;
  try{const base=new URL(url);valid=base.protocol==='https:'&&!base.username&&!base.password&&!base.search&&!base.hash&&base.pathname==='/'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname);if(!key?.startsWith('sb_secret_')&&JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role!=='service_role')valid=false;}catch{valid=false;}
  if(!valid||!key)throw Error('CONFIGURATION_REQUIRED');
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:(input,init)=>fetch(input,{...init,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(8000)})}});
  console.log(JSON.stringify(await readAiAttemptDiagnostics({rpc:(name,args)=>client.rpc(name,args)},job),null,2));
 }
}catch{console.error(JSON.stringify({status:'BLOCKED',message:'Check explicit connection flag, job ID and private staging configuration. No credential or remote diagnostic text is printed.'}));process.exitCode=1;}
