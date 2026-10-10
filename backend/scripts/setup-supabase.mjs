import {randomBytes} from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const backendDir = fileURLToPath(new URL('..', import.meta.url));
const frontendDir = path.resolve(backendDir, '../frontend');
const envPath = path.join(frontendDir, '.env.local');
const migrationDir = path.join(backendDir, 'supabase/migrations');
const outputPath = path.join(backendDir, 'supabase/setup.sql');

async function prepare() {
  try { await access(envPath); }
  catch { await writeFile(envPath, await readFile(path.join(frontendDir, '.env.example'), 'utf8'), {flag:'wx'}); }
  const existingEnv=await readFile(envPath,'utf8');
  if(!parseEnv(existingEnv).INVITATION_TOKEN_SECRET){
    const secret=randomBytes(32).toString('hex');
    const updated=/^INVITATION_TOKEN_SECRET=.*$/m.test(existingEnv)?existingEnv.replace(/^INVITATION_TOKEN_SECRET=.*$/m,'INVITATION_TOKEN_SECRET='+secret):existingEnv.trimEnd()+'\nINVITATION_TOKEN_SECRET='+secret+'\n';
    await writeFile(envPath,updated);
  }
  const workerEnv=await readFile(envPath,'utf8');
  if(!parseEnv(workerEnv).CRON_SECRET){
    const secret=randomBytes(32).toString('hex');
    await writeFile(envPath,/^CRON_SECRET=.*$/m.test(workerEnv)?workerEnv.replace(/^CRON_SECRET=.*$/m,'CRON_SECRET='+secret):workerEnv.trimEnd()+'\nCRON_SECRET='+secret+'\n');
  }
  let completeEnv=await readFile(envPath,'utf8');
  for(const name of ['SUPABASE_SERVICE_ROLE_KEY','INVITATION_MAIL_URL','INVITATION_MAIL_TOKEN','INTAKE_ENCRYPTION_KEY','OPENAI_API_KEY','OPENAI_ANALYSIS_MODEL','AI_PLATFORM_ENABLED','AI_PROCESSING_APPROVED','AI_RUBRIC_APPROVED','AI_APPROVED_LANGUAGES','AI_DRAFTS_ENABLED','OPERATIONAL_LOGS_ENABLED','INTAKE_ENCRYPTION_KEYS','INVITATION_TOKEN_KEYS','INTAKE_SIGNING_ROOT_KEYS'])if(!(name in parseEnv(completeEnv)))completeEnv=completeEnv.trimEnd()+'\n'+name+'=\n';
  if(!parseEnv(completeEnv).INTAKE_ENCRYPTION_KEY){const value=randomBytes(32).toString('hex');completeEnv=/^INTAKE_ENCRYPTION_KEY=.*$/m.test(completeEnv)?completeEnv.replace(/^INTAKE_ENCRYPTION_KEY=.*$/m,'INTAKE_ENCRYPTION_KEY='+value):completeEnv.trimEnd()+'\nINTAKE_ENCRYPTION_KEY='+value+'\n';}
  await writeFile(envPath,completeEnv);
  const files = (await readdir(migrationDir)).filter(name => /^\d+_.+\.sql$/.test(name)).sort();
  if (!files.length) throw new Error('No migration sources found.');
  const pieces = [];
  for (const name of files) {
    const source = (await readFile(path.join(migrationDir, name), 'utf8')).replaceAll('\r\n', '\n');
    if ((source.match(/^begin;\s*$/gm) || []).length !== 1 || (source.match(/^commit;\s*$/gm) || []).length !== 1) {
      throw new Error(`Migration ${name} does not have the expected transaction framing.`);
    }
    pieces.push(`-- Source: ${name}\n${source.replace(/^begin;\s*$/m, '').replace(/^commit;\s*$/m, '').trim()}`);
  }
  const guard = `do $$\nbegin\n if exists (select 1 from pg_catalog.pg_tables where schemaname='public' and tablename in ('agencies','memberships','leads','messages','activity_events')) then\n  raise exception 'LeadPilot tables already exist. Apply only the missing versioned migrations; do not rerun this setup bundle.';\n end if;\nend;\n$$;`;
  const sql = `-- Generated from versioned migrations. Regenerate with pnpm setup:supabase.\n-- Apply once to a development project without existing LeadPilot tables.\n-- All schema changes commit together; existing LeadPilot tables stop setup.\nbegin;\n${guard}\n\n${pieces.join('\n\n')}\n\ncommit;\n`;
  await writeFile(outputPath, sql);
  console.log(`Prepared ${files.length} migrations as backend/supabase/setup.sql.`);
  console.log('frontend/.env.local is ready; existing values were preserved.');
  console.log('No remote connection or database change has been performed.');
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value=value.slice(1,-1);
    else value=value.replace(/\s+#.*$/, '').trim();
    env[match[1]]=value;
  }
  return env;
}
async function check() {
  let values;
  try { values=parseEnv(await readFile(envPath, 'utf8')); }
  catch { console.log('MISSING frontend/.env.local. Run pnpm setup:supabase from backend.'); return false; }
  const issues=[];
  if(!/^[a-f0-9]{64,}$/.test(values.INVITATION_TOKEN_SECRET??''))issues.push('INVITATION_TOKEN_SECRET is missing/invalid. Run setup:supabase to generate it.');
  for (const name of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','APP_URL']) {
    if (!values[name]?.trim()) issues.push(`${name} is missing.`);
  }
  if (values.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      const url=new URL(values.NEXT_PUBLIC_SUPABASE_URL);
      const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
      if ((url.protocol!=='https:' && !(local && url.protocol==='http:')) || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw new Error();
    } catch {issues.push('NEXT_PUBLIC_SUPABASE_URL must be the project base URL.');}
  }
  if(process.argv.includes('--workers')){
    if((values.CRON_SECRET??'').length<32)issues.push('CRON_SECRET is missing/invalid.');
    const workerKey=values.SUPABASE_SERVICE_ROLE_KEY;
    if(!workerKey)issues.push('SUPABASE_SERVICE_ROLE_KEY is missing.');
    else if(!workerKey.startsWith('sb_secret_')){try{if(JSON.parse(Buffer.from(workerKey.split('.')[1],'base64url').toString()).role!=='service_role')throw new Error();}catch{issues.push('SUPABASE_SERVICE_ROLE_KEY must be a private worker key.');}}
  }
  if(process.argv.includes('--intake')&&!/^[a-f0-9]{64}$/.test(values.INTAKE_ENCRYPTION_KEY??''))issues.push('INTAKE_ENCRYPTION_KEY is missing/invalid.');
  const key=values.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if(key && !key.startsWith('sb_publishable_')) {
    try {
      const [header,payload,signature,...extra]=key.split('.');
      if (!header || !signature || extra.length || JSON.parse(Buffer.from(payload,'base64url').toString()).role!=='anon') throw new Error();
    } catch {issues.push('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY must be a publishable key or legacy anon key; privileged keys are not accepted.');}
  }
  if(values.APP_URL) {
    try {const url=new URL(values.APP_URL);if(url.origin!=='http://localhost:4000' || url.pathname!=='/' || url.search || url.hash || url.username || url.password)throw new Error();}
    catch {issues.push('APP_URL for this development setup must be http://localhost:4000.');}
  }
  for (const issue of issues) console.log(`MISSING/INVALID ${issue}`);
  if (!issues.length) console.log('Local configuration looks valid. Hosted Auth, migrations and lead saving still need verification.');
  return issues.length===0;
}

try {
  if(process.argv.includes('--check')) process.exitCode=(await check())?0:1;
  else await prepare();
} catch {
  console.error('Supabase setup could not complete. Check local file access and migration transaction framing.');
  process.exitCode=1;
}
