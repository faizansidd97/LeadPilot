import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FollowUpQueue,validateFollowUpPage} from '../../frontend/src/lib/follow-up-workflow.ts';
import {followUpCursorValue,followUpListSchema,type FollowUpInboxRow} from '../src/domain/workflows.ts';
import {localDatabase,identity,seedPrivacyFixture} from './helpers/local-db.ts';

const tenant=crypto.randomUUID(),leadId=crypto.randomUUID(),id=crypto.randomUUID(),due='2030-01-01T00:00:00.000100+00:00';
const row:FollowUpInboxRow={id,tenant_id:tenant,lead_id:leadId,assignee_id:null,type:'INTERNAL',title:'Synthetic task',due_at:due,state:'OPEN',version:1,schedule_version:1,leads:{id:leadId,full_name:'Synthetic lead'}};
const page=(rows:unknown[]=[row],cursor:string|null=null)=>({follow_ups:rows,pagination:{next_cursor:cursor}});
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const failure=(status=503)=>Object.assign(new Error('Fixture unavailable'),{status});
const deferred=<T>()=>{let resolve!:(value:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve};};
const lead={id:leadId,tenant_id:tenant,version:3,full_name:'Latest synthetic lead',status:'NEW',source:'MANUAL',email:'synthetic@example.test',phone:null,duplicate_review:false,archived_at:null,locations:[],notes:'',confirmed_intent:null,budget_period:'UNKNOWN',property_type:null,bedrooms:null,purchase_timeline:null,source_reference:null};
const hundred=()=>Array.from({length:100},(_,i)=>({...row,id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,due_at:`2030-01-01T00:00:00.${String(i+1).padStart(6,'0')}+00:00`}));

test('Follow-up projection rejects foreign scope, wrong joined lead, malformed preview and oversized results',()=>{
 const result=validateFollowUpPage(page([{...row,notes:'Private notes',created_by:id,leads:{...row.leads,email:'private@example.test'}}]),tenant,'OPEN').rows[0];
 assert.equal('notes' in result,false);assert.equal('created_by' in result,false);assert.equal('email' in result.leads,false);
 for(const change of [{tenant_id:crypto.randomUUID()},{state:'COMPLETED'},{leads:{id:crypto.randomUUID(),full_name:'Other'}},{leads:null},{title:' '},{title:'x'.repeat(151)},{version:0},{schedule_version:0},{due_at:'invalid'},{type:'SMS'},{assignee_id:'private'}])assert.throws(()=>validateFollowUpPage(page([{...row,...change}]),tenant,'OPEN'));
 assert.throws(()=>validateFollowUpPage(page(Array.from({length:101},()=>row)),tenant,'OPEN'));assert.throws(()=>validateFollowUpPage({follow_ups:[],pagination:{}},tenant,'OPEN'));
});
test('Server list and cursor contracts preserve exact due precision and reject authority or malformed cursor fields',()=>{
 assert.deepEqual(followUpCursorValue(row),{due_at:due,id});assert.notEqual(followUpCursorValue(row).due_at,new Date(due).toISOString());
 for(const value of [{state:'UNKNOWN'},{limit:101},{tenant_id:tenant},{lead_id:'bad'},{cursor:'x'.repeat(513)}])assert.equal(followUpListSchema.safeParse(value).success,false);
 assert.deepEqual(followUpListSchema.parse({state:'OPEN',limit:'100',lead_id:leadId}).limit,100);
 assert.throws(()=>followUpCursorValue({...row,due_at:'bad'}));
});
test('Queue keyset validation keeps sub-millisecond order, UUID ties and strictly advancing boundaries',()=>{
 const a={...row,id:'00000000-0000-4000-8000-000000000001',due_at:'2030-01-01T00:00:00.000100Z'},b={...a,id:'00000000-0000-4000-8000-000000000002'},c={...a,id:'00000000-0000-4000-8000-000000000003',due_at:'2030-01-01T00:00:00.000101Z'};
 assert.equal(validateFollowUpPage(page([a,b,c]),tenant,'OPEN').rows.length,3);
 for(const rows of [[c,a],[b,a],[a,a]])assert.throws(()=>validateFollowUpPage(page(rows),tenant,'OPEN'));
 assert.throws(()=>validateFollowUpPage(page([b]),tenant,'OPEN',c));assert.throws(()=>validateFollowUpPage(page([a]),tenant,'OPEN',a));
 assert.equal(validateFollowUpPage(page([c]),tenant,'OPEN',b).rows.length,1);
});
test('Queue cursor must bind the exact final timestamp and ID on a full page',()=>{
 const rows=hundred(),last=rows.at(-1)!;assert.equal(validateFollowUpPage(page(rows,encode(followUpCursorValue(last))),tenant,'OPEN').rows.length,100);
 assert.equal(validateFollowUpPage(page(rows,encode({id:last.id,due_at:'2030-01-01T04:00:00.000100+04:00'})),tenant,'OPEN').rows.length,100);
 for(const cursor of ['bad',encode({...followUpCursorValue(last),private_key:'hidden'}),encode({id,last_due:last.due_at}),encode({id:last.id,due_at:new Date(last.due_at).toISOString()}),encode({id:crypto.randomUUID(),due_at:last.due_at})])assert.throws(()=>validateFollowUpPage(page(rows,cursor),tenant,'OPEN'));
 assert.throws(()=>validateFollowUpPage(page(rows.slice(0,99),encode(followUpCursorValue(last))),tenant,'OPEN'));
});
test('Failed initial queue reads are unavailable; explicit refresh confirms empty without replacing failures with zero rows',async()=>{
 let fail=true,calls=0;const queue=new FollowUpQueue(tenant,async()=>{calls++;if(fail)throw failure();return page([]);},{change:()=>{},open:()=>assert.fail('No open expected')});
 assert.equal(await queue.refresh(),false);assert.equal(queue.state.ready,false);assert.equal(queue.state.loaded,false);assert.ok(queue.state.error);assert.equal(calls,1);
 fail=false;assert.equal(await queue.refresh(),true);assert.equal(queue.state.ready,true);assert.equal(queue.state.loaded,true);assert.equal(queue.state.rows.length,0);assert.equal(queue.state.error,'');
});
test('Same-frame queue reads, paging, filters and opens share one synchronous gate',async()=>{
 const waiting=deferred<unknown>();let calls=0;const queue=new FollowUpQueue(tenant,async()=>{calls++;return waiting.promise;},{change:()=>{},open:()=>assert.fail('No open expected')});
 const pending=queue.refresh();assert.equal(queue.state.busy,true);assert.equal(await queue.refresh(),false);assert.equal(await queue.refresh(true),false);assert.equal(await queue.filter('COMPLETED'),false);assert.equal(await queue.open(row),false);assert.equal(calls,1);
 waiting.resolve(page());await pending;assert.equal(queue.state.ready,true);assert.equal(queue.state.busy,false);assert.equal(queue.state.filter,'OPEN');
});
test('Closed queue and revision/effect replay fence ignored-abort rows, errors and completion callbacks',async()=>{
 const first=deferred<unknown>();let calls=0,changes=0;const queue=new FollowUpQueue(tenant,async()=>++calls===1?first.promise:page([{...row,title:'Fresh after activation'}]),{change:()=>changes++,open:()=>assert.fail('No open expected')});
 const pending=queue.refresh();queue.close();queue.activate();await queue.refresh();const currentChanges=changes;first.resolve(page([{...row,title:'Stale before close'}]));await pending;
 assert.equal(changes,currentChanges);assert.equal(queue.state.rows[0].title,'Fresh after activation');queue.close();assert.equal(await queue.refresh(),false);
});
test('Paging failure keeps unavailable history, blocks rows and reads a fresh first page on recovery',async()=>{
 const rows=hundred(),cursor=encode(followUpCursorValue(rows.at(-1)!));let calls=0;const queue=new FollowUpQueue(tenant,async path=>{calls++;if(calls===1)return page(rows,cursor);if(path.includes('cursor='))throw failure();return page([{...row,title:'Current after recovery'}]);},{change:()=>{},open:()=>assert.fail('No open expected')});
 await queue.refresh();assert.equal(await queue.refresh(true),false);assert.equal(queue.state.rows.length,100);assert.equal(queue.state.loaded,true);assert.equal(queue.state.ready,false);assert.equal(await queue.open(rows[0]),false);assert.equal(await queue.refresh(true),false);assert.equal(calls,2);
 await queue.refresh();assert.equal(queue.state.rows.length,1);assert.equal(queue.state.rows[0].title,'Current after recovery');assert.equal(queue.state.cursor,null);
});
test('Paging cannot append overlapping or reordered snapshots and never silently deduplicates changed task rows',async()=>{
 const rows=hundred(),cursor=encode(followUpCursorValue(rows.at(-1)!));let next:unknown=page([{...rows[0],due_at:'2030-01-01T00:00:01Z'}]);const queue=new FollowUpQueue(tenant,async path=>path.includes('cursor=')?next:page(rows,cursor),{change:()=>{},open:()=>{}});
 await queue.refresh();assert.equal(await queue.refresh(true),false);assert.equal(queue.state.rows.length,100);await queue.refresh();next=page([{...row,id:crypto.randomUUID(),due_at:'2029-12-31T00:00:00Z'}]);assert.equal(await queue.refresh(true),false);assert.equal(queue.state.rows.length,100);
 await queue.refresh();next=page([{...row,id:crypto.randomUUID(),due_at:'2030-01-01T00:00:00.000101Z'}]);await queue.refresh(true);assert.equal(queue.state.rows.length,101);
});
test('A delayed page cannot change a replacement filter, and closed filter callbacks publish nothing',async()=>{
 const rows=hundred(),cursor=encode(followUpCursorValue(rows.at(-1)!)),waiting=deferred<unknown>();let changes=0,calls=0;
 const queue=new FollowUpQueue(tenant,async path=>{calls++;if(path.includes('cursor='))return waiting.promise;if(path.includes('state=CANCELLED'))return page([{...row,state:'CANCELLED'}]);return page(rows,cursor);},{change:()=>changes++,open:()=>{}});
 await queue.refresh();const pending=queue.refresh(true);assert.equal(await queue.refresh(),false);assert.equal(await queue.filter('COMPLETED'),false);assert.equal(calls,2);queue.close();const before=changes;assert.equal(await queue.filter('CANCELLED'),false);assert.equal(changes,before);
 queue.activate();await queue.filter('CANCELLED');const current=changes;waiting.resolve(page([{...row,due_at:'2030-01-01T00:00:01Z'}]));await pending;assert.equal(changes,current);assert.equal(queue.state.filter,'CANCELLED');assert.equal(queue.state.rows.length,1);assert.equal(queue.state.rows[0].state,'CANCELLED');
});
test('Filter changes reset history and publish only current matching state, including definitive recipient denial',async()=>{
 let denied=false;const paths:string[]=[];const queue=new FollowUpQueue(tenant,async path=>{paths.push(path);if(denied)throw failure(403);const state=new URL(path,'https://fixture.test').searchParams.get('state');return page([{...row,state}]);},{change:()=>{},open:()=>{}});
 await queue.refresh();await queue.filter('COMPLETED');assert.equal(queue.state.rows[0].state,'COMPLETED');assert.ok(paths.at(-1)?.includes('state=COMPLETED'));assert.equal(queue.state.cursor,null);
 denied=true;await queue.filter('CANCELLED');assert.equal(queue.state.rows.length,0);assert.equal(queue.state.ready,false);assert.equal(queue.state.loaded,false);assert.equal(queue.state.busy,false);
});
test('Open uses fresh scoped projected lead data and holds other actions until the current callback',async()=>{
 const waiting=deferred<unknown>();let opened:Record<string,unknown>|null=null;const methods:unknown[]=[];const queue=new FollowUpQueue(tenant,async(path,options,scope)=>{assert.equal(scope,tenant);methods.push(options.method);return path.startsWith('/api/v1/leads/')?waiting.promise:page();},{change:()=>{},open:value=>{assert.equal(queue.state.busy,false);opened=value;}});
 await queue.refresh();assert.equal(await queue.open({...row,version:99}),false);const pending=queue.open(row);assert.equal(await queue.refresh(),false);assert.equal(await queue.filter('COMPLETED'),false);
 waiting.resolve({...lead,private_error:'hidden'});await pending;assert.equal((opened as any).full_name,lead.full_name);assert.equal((opened as any).version,3);assert.equal('private_error' in opened!,false);assert.ok(methods.every(method=>method===undefined));
});
test('Open cannot navigate on foreign/malformed, removed or revoked lead reads; unavailable rows require refresh',async()=>{
 for(const value of [{...lead,tenant_id:crypto.randomUUID()},{...lead,id:crypto.randomUUID()},{...lead,version:0},failure(404),failure(403),failure(401),failure(503)]){
  let opens=0;const queue=new FollowUpQueue(tenant,async path=>{if(path.startsWith('/api/v1/leads/')){if(value instanceof Error)throw value;return value;}return page();},{change:()=>{},open:()=>opens++});await queue.refresh();await queue.open(row);assert.equal(opens,0);assert.equal(queue.state.ready,false);assert.equal(queue.state.busy,false);assert.equal(await queue.open(row),false);
  if(value instanceof Error&&[401,403,404].includes(value.status))assert.equal(queue.state.rows.length,0);else assert.equal(queue.state.rows.length,1);
 }
});
test('Navigating away closes in-flight lead opening without stale workspace selection',async()=>{
 const waiting=deferred<unknown>();let opens=0,changes=0,signal:AbortSignal|undefined;const queue=new FollowUpQueue(tenant,async(path,options)=>{if(path.startsWith('/api/v1/leads/')){signal=options.signal as AbortSignal;return waiting.promise;}return page();},{change:()=>changes++,open:()=>opens++});
 await queue.refresh();const pending=queue.open(row);queue.close();assert.equal(signal?.aborted,true);const previousChanges=changes;waiting.resolve(lead);await pending;assert.equal(opens,0);assert.equal(changes,previousChanges);assert.equal(queue.state.rows.length,0);
});
test('Actual SQL queue projection/keyset preserves all microsecond tasks and current RLS without writes',async()=>{
 const db=await localDatabase();try{const f=await seedPrivacyFixture(db),member=f.members[f.agent+f.agency.id];await db.exec('reset role');
 await db.query("insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,due_at,created_by) select $1,$2,$3,'INTERNAL','Synthetic queue task',timestamptz '2030-01-01T00:00:00Z'+i*interval '1 microsecond',$4 from generate_series(1,102) i",[f.agency.id,f.lead.id,member,f.owner]);
 await db.query("insert into public.follow_ups(tenant_id,lead_id,type,title,due_at,created_by) values($1,$2,'INTERNAL','Foreign queue task','2030-01-01',$3)",[f.foreign.id,f.foreignLead.id,f.other]);
 await identity(db,f.agent);let opened:Record<string,unknown>|null=null;
 async function transport(path:string,options:RequestInit,scope:string){assert.equal(options.method,undefined);assert.equal(scope,f.agency.id);if(path.startsWith('/api/v1/leads/'))return (await db.query<any>('select to_jsonb(l) row from public.leads l where id=$1',[f.lead.id])).rows[0]?.row??Promise.reject(failure(404));
  const params=new URL(path,'https://fixture.test').searchParams,raw=params.get('cursor'),cursor=raw?JSON.parse(Buffer.from(raw,'base64url').toString('utf8')):null;
  const rows=(await db.query<any>("select to_jsonb(t)||jsonb_build_object('leads',jsonb_build_object('id',l.id,'full_name',l.full_name)) row from public.follow_ups t join public.leads l on l.id=t.lead_id and l.tenant_id=t.tenant_id where t.tenant_id=$1 and t.state=$2 and ($3::timestamptz is null or (t.due_at,t.id)>($3::timestamptz,$4::uuid)) order by t.due_at,t.id limit 101",[scope,params.get('state'),cursor?.due_at??null,cursor?.id??null])).rows.map(r=>r.row);const visible=rows.slice(0,100);return page(visible,rows.length>100?encode(followUpCursorValue(visible.at(-1)!)):null);
 }
 const before=(await db.query<any>('select sum(version)::int versions,sum(schedule_version)::int schedules from public.follow_ups')).rows[0];
 const queue=new FollowUpQueue(f.agency.id,transport,{change:()=>{},open:value=>{opened=value;}});await queue.refresh();assert.equal(queue.state.rows.length,100);const cursor=JSON.parse(Buffer.from(queue.state.cursor!,'base64url').toString('utf8'));assert.equal((await db.query<{exact:boolean}>("select $1::timestamptz=timestamptz '2030-01-01T00:00:00Z'+interval '100 microseconds' exact",[cursor.due_at])).rows[0].exact,true);
 const rounded=new Date(cursor.due_at).toISOString();assert.equal((await db.query<any>('select count(*)::int n from public.follow_ups where due_at>$1',[rounded])).rows[0].n,102);
 await queue.refresh(true);assert.equal(queue.state.rows.length,102);assert.equal(new Set(queue.state.rows.map(r=>r.id)).size,102);assert.equal(queue.state.cursor,null);await queue.open(queue.state.rows[0]);assert.equal((opened as any).id,f.lead.id);
 assert.deepEqual((await db.query<any>('select sum(version)::int versions,sum(schedule_version)::int schedules from public.follow_ups')).rows[0],before);
 await identity(db,f.other);await queue.refresh();assert.equal(queue.state.rows.length,0);assert.equal((await db.query('select id from public.follow_ups where tenant_id=$1',[f.agency.id])).rows.length,0);
 await db.exec('reset role');await db.query('update public.memberships set active=false where id=$1',[member]);await identity(db,f.agent);await queue.refresh();assert.equal(queue.state.rows.length,0);assert.equal((await db.query('select id from public.leads where id=$1',[f.lead.id])).rows.length,0);
 }finally{await db.close();}
});
