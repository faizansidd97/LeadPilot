import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {parseEnv} from './local-evidence.mjs';
import {checkPlatformHealth} from '../src/server/platform-monitor.ts';
const usage='Read-only platform health: --connect-staging [--staging-config PATH].\nRequires staging HTTPS APP_URL and CRON_SECRET. No config reads or connection without the flag. Exit 0: fresh snapshot with no alerts; 1: attention; 2: unavailable/blocked. No jobs, retries, migrations, provider calls, paging or scheduler deployment. No raw credentials, URLs, response bodies or remote errors are printed.';
try{
 const {values}=parseArgs({options:{help:{type:'boolean'},'connect-staging':{type:'boolean'},'staging-config':{type:'string'}},strict:true,allowPositionals:false});
 if(values.help)console.log(usage);else{
  if(!values['connect-staging'])throw Error('CONNECT_REQUIRED');
  const env=values['staging-config']?parseEnv(await readFile(values['staging-config'],'utf8')):process.env;
  const report=await checkPlatformHealth(env);console.log(JSON.stringify(report,null,2));
  process.exitCode=report.status==='NO_ALERTS'?0:report.status==='ATTENTION'?1:2;
 }
}catch{console.error(JSON.stringify({status:'BLOCKED',message:'Check explicit connection flag, options and private staging monitor configuration. No remote error or credential text is printed.'}));process.exitCode=2;}
