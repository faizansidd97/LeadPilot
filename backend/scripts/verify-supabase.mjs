import {parseArgs} from 'node:util';
import {readFile} from 'node:fs/promises';
import {parseEnv} from './local-evidence.mjs';
import {verifyStaging} from '../src/server/staging-verification.ts';
const usage = 'Read-only staging baseline: --connect-staging [--staging-config PATH].\nNo connection or config-file read without --connect-staging. Supply a staging HTTPS project URL and public publishable/legacy anon key. Never supply a service key. Checks email confirmation/signup and anonymous denial on all current public business tables. No accounts, migrations, workers, provider calls or authenticated acceptance are performed.';
try {
  const {values} = parseArgs({options:{help:{type:'boolean'},'connect-staging':{type:'boolean'},'staging-config':{type:'string'}},strict:true,allowPositionals:false});
  if (values.help) console.log(usage);
  else {
    if (!values['connect-staging']) throw Error('CONNECT_REQUIRED');
    const env = values['staging-config'] ? parseEnv(await readFile(values['staging-config'],'utf8')) : process.env;
    const report = await verifyStaging(env);
    console.log(JSON.stringify(report,null,2));
    if (report.status !== 'BASELINE_PASS') process.exitCode = 1;
  }
} catch {
  console.error(JSON.stringify({status:'BLOCKED',message:'Check explicit connection flag, options and public staging configuration. No secret or remote error text is printed.'}));
  process.exitCode = 1;
}
