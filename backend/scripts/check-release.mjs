import {readFile} from 'node:fs/promises';
import {fingerprint,parseEnv,workspace} from './local-evidence.mjs';
const issues=[];
try{const manifest=JSON.parse(await readFile(new URL('docs/LOCAL_CHECKS.json',workspace),'utf8')),current=await fingerprint();if(manifest.status!=='PASS'||manifest.source.sha256!==current.sha256)issues.push('Local verification is failed or stale for current source.');}catch{issues.push('Current local verification evidence is missing.');}
let env={};try{env=parseEnv(await readFile(new URL('frontend/.env.local',workspace),'utf8'));}catch{issues.push('Deployment configuration is unavailable.');}
for(const name of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','SUPABASE_SERVICE_ROLE_KEY','INVITATION_TOKEN_SECRET','CRON_SECRET','INTAKE_ENCRYPTION_KEY'])if(!env[name])issues.push(name+' is unconfigured.');
try{const app=new URL(env.APP_URL);if(app.protocol!=='https:'||app.username||app.password||app.search||app.hash||app.pathname!=='/'||['localhost','127.0.0.1','[::1]'].includes(app.hostname))throw Error();}catch{issues.push('Release APP_URL must be a configured public HTTPS base origin.');}
if(env.AI_PLATFORM_ENABLED==='true')for(const name of ['OPENAI_API_KEY','OPENAI_ANALYSIS_MODEL','AI_APPROVED_LANGUAGES'])if(!env[name])issues.push(name+' is required for enabled AI.');
if(env.AI_PLATFORM_ENABLED==='true'&&(env.AI_PROCESSING_APPROVED!=='true'||env.AI_RUBRIC_APPROVED!=='true'))issues.push('Enabled AI lacks recorded processing/rubric configuration.');
// External evidence is intentionally not accepted from an environment flag or a local test.
issues.push('Approved retention/deletion/backup policy and erasure/closure/restore-deletion replay implementation: pending (A22).','Separate hosted environment, migrations, Auth/MFA/RLS, transport, cron and rotation verification: pending.','50 real concurrent users, HTTP/UI/provider measurements and purchased-tier RPO/RTO: pending (A23).','Permitted responsive/keyboard/screen-reader/error browser UAT and reviewer sign-off: pending (A24).','Approved live AI/provider/language evaluation and processing region evidence: pending if AI is enabled.','Concrete staging release review and human deployment approval: pending.');
console.log(JSON.stringify({status:'NOT_READY',checks:'Offline only; no network, secret values or deployment',issues},null,2));process.exitCode=1;
