import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import {localDatabase,identity,rpc} from '../tests/helpers/local-db.ts';
const db=await localDatabase(),started=performance.now();
try{
 const users=Array.from({length:50},()=>crypto.randomUUID()),tenantKey=crypto.randomUUID();
 for(const id of users)await db.query('insert into auth.users values($1,now(),$2)',[id,id+'@example.test']);
 await identity(db,users[0]);const tenant=(await rpc(db,'create_agency',[{name:'Synthetic load fixture'},tenantKey,crypto.randomUUID()])).agency.id;
 await db.exec('reset role');
 for(let i=1;i<users.length;i++)await db.query('insert into public.memberships(tenant_id,user_id,role) values($1,$2,$3)',[tenant,users[i],i<10?'ADMIN':'AGENT']);
 const members=(await db.query('select id,user_id,role from public.memberships where tenant_id=$1 order by user_id',[tenant])).rows;
 await db.query(`insert into public.leads(tenant_id,assignee_id,full_name,email,source,created_by)
 select $1,($3::uuid[])[1+((n-1)%50)],'Synthetic '||n,'synthetic-'||n||'@example.test','MANUAL',$2 from generate_series(1,10000) n`,[tenant,users[0],members.map(m=>m.id)]);
 await db.query(`insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,due_at,created_by)
 select tenant_id,id,assignee_id,'INTERNAL','Synthetic task',now()-interval '1 hour',$2 from
 (select l.*,row_number() over(partition by assignee_id order by id) rn from public.leads l where tenant_id=$1) s where rn<=20`,[tenant,users[0]]);
 await db.exec('analyze public.leads;analyze public.follow_ups;analyze public.memberships');
 const samples={inbox:[],detail:[],dashboard:[],follow_ups:[]};
 async function measure(name,operation,record){const start=performance.now(),value=await operation();if(record)samples[name].push(performance.now()-start);return value;}
 async function workload(m,record){
  await identity(db,m.user_id);
  const list=await measure('inbox',()=>db.query('select * from public.list_leads($1,25)',[tenant]),record);assert.equal(list.rows.length,25);
  const detail=await measure('detail',()=>db.query('select * from public.leads where tenant_id=$1 and id=$2',[tenant,list.rows[0].id]),record);assert.equal(detail.rows.length,1);
  const dashboard=await measure('dashboard',()=>rpc(db,'dashboard_summary',[tenant]),record);assert.equal(dashboard.metrics.total,m.role==='AGENT'?200:10000);
  const tasks=await measure('follow_ups',()=>db.query("select f.id,f.lead_id,f.due_at,l.full_name from public.follow_ups f join public.leads l on (l.tenant_id,l.id)=(f.tenant_id,f.lead_id) where f.tenant_id=$1 and f.state='OPEN' order by f.due_at,f.id limit 25",[tenant]),record);assert.equal(tasks.rows.length,m.role==='AGENT'?20:25);
 }
 for(const m of [members.find(m=>m.role==='OWNER'),members.find(m=>m.role==='AGENT')])await workload(m,false);
 for(let round=0;round<2;round++)for(const m of members)await workload(m,true);
 const stats=Object.fromEntries(Object.entries(samples).map(([name,values])=>{const sorted=values.sort((a,b)=>a-b),percentile=q=>Number(sorted[Math.ceil(q*sorted.length)-1].toFixed(2));return [name,{samples:sorted.length,p50_ms:percentile(.5),p95_ms:percentile(.95),p99_ms:percentile(.99),max_ms:Number(sorted.at(-1).toFixed(2))}];}));
 const result={generated_at:new Date().toISOString(),engine:'PGlite 0.5.8, in-process PostgreSQL',node:process.version,platform:os.platform(),architecture:os.arch(),leads:10000,tasks:1000,identities:50,managers:10,agents:40,connections:1,execution:'Sequential identities; NOT 50 concurrent users; no HTTP/browser/provider calls',scope_assertions:'Each manager sees 10000 leads; each agent sees 200 assigned leads and 20 assigned tasks',total_duration_ms:Math.round(performance.now()-started),queries:stats,release_performance_accepted:false};
 const docs=new URL('../../docs/',import.meta.url);await mkdir(docs,{recursive:true});await writeFile(new URL('LOCAL_LOAD_REPORT.json',docs),JSON.stringify(result,null,2)+'\n');
 await writeFile(new URL('LOCAL_LOAD_REPORT.md',docs),`# Local database load observation\n\nGenerated ${result.generated_at}. ${result.engine}; ${result.node}, ${result.platform}/${result.architecture}.\n\nFixture: 10,000 synthetic leads, 1,000 OPEN internal tasks, 50 verified identities (10 managers/40 agents). One PGlite connection runs identities sequentially, two measured rounds and two warm-up identities. Scope assertions pass on every workload. SQL timings include the local JavaScript database call and result decoding, excluding identity switching; total fixture/workload duration ${result.total_duration_ms} ms.\n\n| Query | Samples | p50 ms | p95 ms | p99 ms | Max ms |\n| --- | --- | --- | --- | --- | --- |\n${Object.entries(stats).map(([name,s])=>`| ${name} | ${s.samples} | ${s.p50_ms} | ${s.p95_ms} | ${s.p99_ms} | ${s.max_ms} |`).join('\n')}\n\nThis is not HTTP API latency, browser interactivity, hosted RLS/PostgREST behavior, write contention, 50 real concurrent users, AI latency, availability or purchased-tier backup RPO/RTO evidence. The proposed release targets remain pending. No live credentials or customer data were used.\n\nRepeat from backend with Node >=22.18: \`node --experimental-strip-types scripts/benchmark-local.mjs\`. The isolated database is closed; no dump or customer data file is retained.\n`);
 console.log(JSON.stringify(result));
}finally{await db.close();}
