import {readFile} from 'node:fs/promises';
import {parseEnv} from './local-evidence.mjs';
import {privacyWorkerConfig,runPrivacyWorker,replayPrivacyRestore} from '../src/server/privacy-worker.ts';
import {createClient} from '@supabase/supabase-js';

const args=process.argv.slice(2),help='Use --run-worker --connect, or --restore --connect --bundle <independent-export.json> --sha256 <externally verified digest> [--finish]. No remote action occurs without --connect.';
try{
 if(args.length===1&&args[0]==='--help'){console.log(help);}
 else{
  const allowed=new Set(['--run-worker','--restore','--connect','--bundle','--sha256','--finish']);
  const flags=new Map();for(let i=0;i<args.length;i++){if(!allowed.has(args[i])||flags.has(args[i]))throw Error();const name=args[i];flags.set(name,['--bundle','--sha256'].includes(name)?args[++i]:true);}
  const restore=flags.has('--restore');if(!flags.has('--connect')||restore===flags.has('--run-worker')||!restore&&(flags.has('--finish')||flags.has('--bundle')||flags.has('--sha256'))||restore&&(!flags.get('--bundle')||!flags.get('--sha256')))throw Error();
  const env={...parseEnv(await readFile(new URL('../../frontend/.env.local',import.meta.url),'utf8')),...process.env};
  const config=privacyWorkerConfig(env);const url=new URL(env.NEXT_PUBLIC_SUPABASE_URL??''),key=env.SUPABASE_SERVICE_ROLE_KEY??'';
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!key||key.startsWith('sb_publishable_'))throw Error();
  if(!key.startsWith('sb_secret_')){if(JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString()).role!=='service_role')throw Error();}
  const db=createClient(url.href,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,redirect:'error',cache:'no-store',signal:AbortSignal.timeout(30000)})}});
  if(restore){
   const bytes=await readFile(String(flags.get('--bundle')));
   console.log(JSON.stringify(await replayPrivacyRestore(db,bytes,String(flags.get('--sha256')),config.keys,flags.has('--finish'))));
  }else console.log(JSON.stringify(await runPrivacyWorker(db,config)));
 }
}catch{console.error('Privacy operation did not complete. Keep a restored environment offline; inspect approved configuration and original scope before retrying. '+help);process.exitCode=1;}
