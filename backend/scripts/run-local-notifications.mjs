import {parseArgs} from 'node:util';
import {readFile,writeFile,open,mkdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {parseEnv} from './local-evidence.mjs';
import {localRunnerConfiguration,localNotificationLoop,runLocalNotificationTick,LOCAL_INTERVAL_MS,replaceLocalRunnerStatus} from '../src/server/local-notification-runner.ts';

const cache=new URL('../.cache/',import.meta.url),lock=new URL('local-notifications.lock',cache),
 stopFile=new URL('local-notifications.stop',cache),statusFile=new URL('local-notifications.json',cache);
const stamp=()=>new Date().toISOString();
let ownsLock=false,token,controller,watch,handle;
try{
 const {values}=parseArgs({options:{help:{type:'boolean'},start:{type:'boolean'},stop:{type:'boolean'},status:{type:'boolean'}}});
 if(values.help){console.log('Local development notification runner (Node >=22.18).\n--start: immediate run, then every minute; existing frontend/.env.local; no email/AI dispatch.\n--status: safe last-run status; no configuration read or remote connection.\n--stop: request graceful stop.\nUse Ctrl+C for a foreground runner. No production/startup scheduler is installed.');}
 else if([values.start,values.stop,values.status].filter(Boolean).length!==1){console.error('Choose exactly one of --start, --status or --stop. No configuration read or connection made.');process.exitCode=2;}
 else if(values.status){
  let saved;try{saved=JSON.parse(await readFile(statusFile,'utf8'));}catch{}
  let running=false;try{const owner=JSON.parse(await readFile(lock,'utf8'));process.kill(owner.pid,0);running=true;}catch{}
  console.log(JSON.stringify({running,last_run:saved??null}));
 }else if(values.stop){
  let owner;try{owner=JSON.parse(await readFile(lock,'utf8'));}catch{}
  if(!owner)console.log('Local runner is not running.');
  else{await writeFile(stopFile,JSON.stringify({token:owner.token}),{mode:0o600});console.log('Graceful stop requested. Check --status in a moment; no process was force-killed.');}
 }else{
  const env=parseEnv(await readFile(new URL('../../frontend/.env.local',import.meta.url),'utf8'));
  localRunnerConfiguration(env);
  await mkdir(cache,{recursive:true});token=randomUUID();
  try{handle=await open(lock,'wx',0o600);}catch{throw Error('LOCAL_RUNNER_ALREADY_LOCKED');}
  ownsLock=true;await handle.writeFile(JSON.stringify({pid:process.pid,token,started_at:stamp()}));await handle.close();handle=undefined;
  controller=new AbortController();const stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let checking=false;
  watch=setInterval(async()=>{
   if(checking)return;checking=true;
   try{const request=JSON.parse(await readFile(stopFile,'utf8'));if(request.token===token)stop();}catch{}
   finally{checking=false;}
  },500);
  let report={session_id:token,started_at:stamp(),updated_at:stamp(),state:'RUNNING',interval_ms:LOCAL_INTERVAL_MS,
   mode:'DIRECT_DEVELOPMENT_WORKER_RPC',runs:0,successful_runs:0,failed_runs:0,notifications_written:0,history:[],
   protected_http_verified:false,deployed_scheduler_verified:false,recipient_ui_verified:false,release_accepted:false};
  const save=async()=>{report.updated_at=stamp();const temp=new URL('local-notifications.'+token+'.tmp',cache);
   await writeFile(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});await replaceLocalRunnerStatus(temp,statusFile);};
  await save();console.log('Local notification runner started. Cadence: 60 seconds. No email or AI dispatch.');
  try{
   await localNotificationLoop({signal:controller.signal,tick:signal=>runLocalNotificationTick(env,signal),record:async result=>{
    report.runs++;if(result.status==='PASS'){report.successful_runs++;report.notifications_written+=result.summary.notifications_written;}else report.failed_runs++;
    report.history=[...report.history,{checked_at:stamp(),...result}].slice(-8);await save();
    console.log(JSON.stringify({checked_at:stamp(),...result}));
   }});
   report.state='STOPPED';
  }catch{report.state='FAILED';process.exitCode=1;}
  finally{await save();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
 }
}catch(error){
 console.error(error?.message==='LOCAL_RUNNER_ALREADY_LOCKED'?
  'Runner lock exists. Use --status/--stop. After a crashed process, verify its PID is gone before removing backend/.cache/local-notifications.lock.':
  'Local runner could not start or record its result. Check development configuration and file access; no credential or upstream diagnostic is displayed.');
 process.exitCode=2;
}finally{
 clearInterval(watch);await handle?.close().catch(()=>{});
 if(ownsLock){
  try{const owner=JSON.parse(await readFile(lock,'utf8'));if(owner.token===token)await unlink(lock);}catch{}
  try{const request=JSON.parse(await readFile(stopFile,'utf8'));if(request.token===token)await unlink(stopFile);}catch{}
 }
}
