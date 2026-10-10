import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {fingerprint,workspace} from './local-evidence.mjs';
const backend=new URL('backend/',workspace),frontend=new URL('frontend/',workspace),cache=new URL('.cache/p8-verification/',backend);
await mkdir(cache,{recursive:true});
const checks=[];
async function run(name,directory,args){
 const started=performance.now();let output='';
 const child=spawn(process.execPath,args,{cwd:fileURLToPath(directory),env:{...process.env,NO_COLOR:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});await writeFile(new URL(name+'.log',cache),output);
 const tests=output.match(/(?:ℹ|#) tests (\d+)/),passed=output.match(/(?:ℹ|#) pass (\d+)/);
 const result={name,status:code===0?'PASS':'FAIL',exit_code:code,duration_ms:Math.round(performance.now()-started),...(tests?{tests:Number(tests[1]),passed:Number(passed?.[1]??0)}:{})};checks.push(result);console.log(JSON.stringify(result));
 if(code!==0){console.error('Local verification failed; inspect backend/.cache/p8-verification/'+name+'.log. No release readiness is implied.');return false;}return true;
}
// Bound isolated database/process fixtures on the shared development machine.
const cases=[['regression',backend,['--experimental-strip-types','--test','--test-concurrency=4','tests/*.test.ts']],['backend-types',backend,['node_modules/typescript/bin/tsc','--noEmit']],['frontend-types',frontend,['node_modules/typescript/bin/tsc','--noEmit']],['analysis-contracts',backend,['--experimental-strip-types','scripts/evaluate-analysis.mjs']],['draft-contracts',backend,['--experimental-strip-types','scripts/evaluate-drafts.mjs']],['production-build',frontend,['node_modules/next/dist/bin/next','build']]];
for(const [name,directory,args] of cases)if(!await run(name,directory,args))break;
const result={generated_at:new Date().toISOString(),node:process.version,source:await fingerprint(),status:checks.length===cases.length&&checks.every(c=>c.status==='PASS')?'PASS':'FAIL',checks,scope:'Local synthetic/emulated Auth/database and compiler evidence only',hosted_accepted:false,browser_accepted:false,release_accepted:false};
await writeFile(new URL('docs/LOCAL_CHECKS.json',workspace),JSON.stringify(result,null,2)+'\n');
console.log('Saved docs/LOCAL_CHECKS.json. Hosted, browser and release gates remain pending.');if(result.status!=='PASS')process.exitCode=1;
