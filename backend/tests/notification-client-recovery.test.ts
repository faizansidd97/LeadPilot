import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NotificationWorkflow,validateNotificationPage,verifyNotificationReceipt,resolveNotificationTarget,loadNotificationSummary,type NotificationTarget} from '../../frontend/src/lib/notification-workflow.ts';
import {ClientRequests} from '../../frontend/src/lib/client-workflow.ts';
import type {NotificationRow} from '../src/domain/notifications.ts';
import {localDatabase,identity,rpc,seedPrivacyFixture} from './helpers/local-db.ts';
const tenant=crypto.randomUUID(),id=crypto.randomUUID(),leadId=crypto.randomUUID(),stamp=new Date().toISOString();
const row:NotificationRow={id,type:'LEAD_ASSIGNED',created_at:stamp,read_at:null,dismissed_at:null,version:1,current:true,can_open:true,resource_label:'Synthetic inquiry',due_at:null};
const page=(rows:NotificationRow[]=[row],cursor:string|null=null)=>({notifications:rows,pagination:{next_cursor:cursor}});
const failure=(status=503)=>Object.assign(new Error('Fixture service unavailable'),{status});
const deferred=<T>()=>{let resolve!:(value:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve};};
const lead={id:leadId,tenant_id:tenant,version:1,full_name:'Synthetic inquiry',status:'NEW',source:'MANUAL',email:'synthetic@example.test',phone:null,duplicate_review:false,archived_at:null,locations:[],notes:'',confirmed_intent:null,budget_period:'UNKNOWN',property_type:null,bedrooms:null,purchase_timeline:null,source_reference:null};

test('Notification contracts project safe rows and reject hidden stale previews, invalid filters, duplicates, order and cursor',()=>{
 assert.equal('private_payload' in validateNotificationPage(page([{...row,private_payload:'secret'} as NotificationRow]),'ALL').rows[0],false);
 for(const value of [page([{...row,current:false}]),page([{...row,can_open:false}]),page([{...row,due_at:stamp}]),page([{...row,version:0}]),page([row,row]),page([{...row,dismissed_at:stamp}]),page([row],'invalid')])assert.throws(()=>validateNotificationPage(value,'ALL'));
 assert.throws(()=>validateNotificationPage(page([{...row,read_at:stamp}]),'UNREAD'));assert.throws(()=>validateNotificationPage(page(),'DISMISSED'));
 assert.equal(validateNotificationPage(page([{...row,current:false,can_open:false,resource_label:null}]),'ALL').rows[0].resource_label,null);
 const rows=Array.from({length:25},(_,i)=>({...row,id:crypto.randomUUID(),created_at:new Date(Date.parse(stamp)-i*1000).toISOString()}));const last=rows.at(-1)!;
 const cursor=Buffer.from(JSON.stringify({created_at:last.created_at,id:last.id})).toString('base64url');assert.equal(validateNotificationPage(page(rows,cursor),'ALL').cursor,cursor);assert.throws(()=>validateNotificationPage(page(rows.slice(0,24),cursor),'ALL'));
});
test('Notification paging preserves PostgreSQL microsecond order and rejects overlap/forward rows',()=>{
 const high={...row,id:'00000000-0000-4000-8000-000000000001',created_at:'2026-10-11T00:00:00.123900+00:00'},low={...row,id:'00000000-0000-4000-8000-000000000002',created_at:'2026-10-11T00:00:00.123100+00:00'};
 assert.equal(validateNotificationPage(page([high,low]),'ALL').rows.length,2);assert.equal(validateNotificationPage(page([low]),'ALL',high).rows.length,1);assert.throws(()=>validateNotificationPage(page([high]),'ALL',low));assert.throws(()=>validateNotificationPage(page([low]),'ALL',low));
});
test('Notification list and summary publish together; failed summary makes the inbox unavailable, never caught up',async()=>{
 const summary=deferred<unknown>();let changes=0,count:number|null=99;
 const workflow=new NotificationWorkflow(tenant,async path=>path.endsWith('/summary')?summary.promise:page(),{change:()=>changes++,count:n=>{count=n;},open:()=>{}});
 const load=workflow.refresh();assert.equal(workflow.state.loaded,false);assert.equal(workflow.state.rows.length,0);assert.equal(changes,1);summary.resolve({unread_count:1});await load;assert.equal(workflow.state.ready,true);assert.equal(count,1);
 const unavailable=new NotificationWorkflow(tenant,async path=>{if(path.endsWith('/summary'))throw failure();return page([]);},{change:()=>{},count:n=>{count=n;},open:()=>{}});await unavailable.refresh();assert.equal(unavailable.state.loaded,false);assert.equal(unavailable.state.ready,false);assert.equal(count,null);assert.ok(unavailable.state.error);
});
test('Recipient action gate rejects same-frame overlap and filter changes during an active read',async()=>{
 const delayed=deferred<unknown>();let reads=0;
 const workflow=new NotificationWorkflow(tenant,async path=>{reads++;return path.endsWith('/summary')?{unread_count:1}:delayed.promise;},{change:()=>{},count:()=>{},open:()=>{}});
 const load=workflow.refresh();assert.equal(await workflow.refresh(),false);assert.equal(await workflow.filter('UNREAD'),false);assert.equal(reads,2);delayed.resolve(page());await load;assert.equal(workflow.state.filter,'ALL');
});
test('Closed/reopened notification scope ignores late list, summary and badge callbacks despite ignored abort',async()=>{
 const old=deferred<unknown>();let lists=0,count:number|null=null;
 const workflow=new NotificationWorkflow(tenant,async path=>path.endsWith('/summary')?{unread_count:++lists===1?99:0}:lists===0?old.promise:page([]),{change:()=>{},count:n=>{count=n;},open:()=>{}});
 const pending=workflow.refresh();workflow.close();workflow.activate();await workflow.refresh();old.resolve(page());await pending;assert.equal(workflow.state.rows.length,0);assert.equal(count,0);
});
test('Lost read acknowledgement retains exact original row/body/key and cannot be replaced by dismiss/filter/refresh',async()=>{
 const writes:{body:string;key:string|undefined}[]=[];let first=true;
 const workflow=new NotificationWorkflow(tenant,async(path,options,_tenant,key)=>{if(options.method){writes.push({body:options.body as string,key});if(first){first=false;throw failure();}return {id,version:2,read_at:stamp,dismissed_at:null};}return path.endsWith('/summary')?{unread_count:writes.length?0:1}:page(writes.length?[{...row,version:2,read_at:stamp}]:[row]);},{change:()=>{},count:()=>{},open:()=>{}});
 const input={...row};await workflow.refresh();await workflow.change(input,'read');assert.equal(workflow.state.pending,'write');assert.equal(await workflow.change(row,'dismiss'),false);assert.equal(await workflow.filter('UNREAD'),false);assert.equal(await workflow.refresh(),false);
 input.version=50;assert.equal(await workflow.recover(),true);assert.deepEqual(writes[0],writes[1]);assert.equal(JSON.parse(writes[1].body).expected_version,1);assert.equal(workflow.state.notice,'Marked as read.');
});
test('Confirmed dismiss followed by failed summary recovers reads only, with no false success notice',async()=>{
 let writes=0,failSummary=false,count:number|null=1;
 const workflow=new NotificationWorkflow(tenant,async(path,options)=>{if(options.method){writes++;failSummary=true;return {id,version:2,read_at:null,dismissed_at:stamp};}if(path.endsWith('/summary')){if(failSummary){failSummary=false;throw failure();}return {unread_count:writes?0:1};}return page(writes?[]:[row]);},{change:()=>{},count:n=>{count=n;},open:()=>{}});
 await workflow.refresh();await workflow.change(row,'dismiss');assert.equal(workflow.state.pending,'refresh');assert.equal(workflow.state.notice,'');assert.equal(count,null);await workflow.recover();assert.equal(writes,1);assert.equal(workflow.state.notice,'Notification dismissed.');assert.equal(count,0);
});
test('Notification paging cannot race refresh/filter or append stale overlapping rows',async()=>{
 const rows=Array.from({length:25},(_,i)=>({...row,id:crypto.randomUUID(),created_at:new Date(Date.parse(stamp)-i*1000).toISOString()})),last=rows.at(-1)!;
 const cursor=Buffer.from(JSON.stringify({created_at:last.created_at,id:last.id})).toString('base64url'),older={...row,id:crypto.randomUUID(),created_at:new Date(Date.parse(stamp)-30000).toISOString()},delayed=deferred<unknown>();let overlap=false;
 const workflow=new NotificationWorkflow(tenant,async path=>path.endsWith('/summary')?{unread_count:26}:path.includes('&cursor=')?overlap?page([last]):delayed.promise:page(rows,cursor),{change:()=>{},count:()=>{},open:()=>{}});
 await workflow.refresh();const more=workflow.refresh(true);assert.equal(await workflow.refresh(),false);assert.equal(await workflow.filter('DISMISSED'),false);delayed.resolve(page([older]));await more;assert.equal(workflow.state.rows.length,26);
 await workflow.refresh();overlap=true;assert.equal(await workflow.refresh(true),false);assert.equal(workflow.state.rows.length,25);assert.equal(workflow.state.ready,false);
});
test('Opening loses resource access after a confirmed read without navigating to cached preflight data',async()=>{
 let writes=0,opens=0,targetReads=0;
 const workflow=new NotificationWorkflow(tenant,async(path,options)=>{if(options.method){writes++;return {id,version:2,read_at:stamp,dismissed_at:null};}if(path.endsWith('/open'))return ++targetReads===1?{available:true,kind:'lead',lead_id:leadId,task_id:null}:{available:false};if(path===`/api/v1/leads/${leadId}`)return lead;return path.endsWith('/summary')?{unread_count:writes?0:1}:page([{...row,version:writes?2:1,read_at:writes?stamp:null,current:!writes,can_open:!writes,resource_label:writes?null:row.resource_label}]);},{change:()=>{},count:()=>{},open:()=>opens++});
 await workflow.refresh();await workflow.open(row);assert.equal(opens,0);assert.equal(writes,1);assert.equal(workflow.state.pending,null);assert.match(workflow.state.notice,/no longer available/);assert.equal(workflow.state.rows[0].resource_label,null);
});
test('Malformed/wrong receipt or stale refreshed row cannot acknowledge read; original recovery persists',async()=>{
 assert.throws(()=>verifyNotificationReceipt({id:crypto.randomUUID(),version:2,read_at:stamp,dismissed_at:null},row,'read'));assert.throws(()=>verifyNotificationReceipt({id,version:1,read_at:stamp,dismissed_at:null},row,'read'));assert.throws(()=>verifyNotificationReceipt({id,version:2,read_at:null,dismissed_at:null},row,'read'));
 const alreadyRead={...row,read_at:'2026-10-11T00:00:00.123100Z'};verifyNotificationReceipt({id,version:2,read_at:'2026-10-11T00:00:00.123100+00:00',dismissed_at:stamp},alreadyRead,'dismiss');assert.throws(()=>verifyNotificationReceipt({id,version:2,read_at:'2026-10-11T00:00:00.123101Z',dismissed_at:stamp},alreadyRead,'dismiss'));
 let malformed=true;const workflow=new NotificationWorkflow(tenant,async(path,options)=>{if(options.method)return {id,version:malformed?7:2,read_at:stamp,dismissed_at:null};return path.endsWith('/summary')?{unread_count:1}:page();},{change:()=>{},count:()=>{},open:()=>{}});
 await workflow.refresh();await workflow.change(row,'read');assert.equal(workflow.state.pending,'write');malformed=false;await workflow.recover();assert.equal(workflow.state.pending,'refresh');assert.equal(workflow.state.notice,'');assert.equal(workflow.state.ready,false);
});
test('Definitive recipient denial clears protected rows/recovery; conflict preserves only unavailable previous history',async()=>{
 for(const status of [401,403,404,409]){const workflow=new NotificationWorkflow(tenant,async(path,options)=>{if(options.method)throw failure(status);return path.endsWith('/summary')?{unread_count:1}:page();},{change:()=>{},count:()=>{},open:()=>{}});await workflow.refresh();await workflow.change(row,'read');assert.equal(workflow.state.pending,null);assert.equal(workflow.state.ready,false);assert.equal(workflow.state.rows.length,status===409?1:0);}
});
test('Open marks read once, then reauthorizes latest lead after read-only recovery before navigation',async()=>{
 let writes=0,leadReads=0,opens=0,opening:NotificationTarget=null;
 const workflow=new NotificationWorkflow(tenant,async(path,options)=>{if(options.method){writes++;return {id,version:2,read_at:stamp,dismissed_at:null};}if(path.endsWith('/open'))return {available:true,kind:'lead',lead_id:leadId,task_id:null};if(path===`/api/v1/leads/${leadId}`){if(++leadReads===2)throw failure();return {...lead,version:leadReads};}return path.endsWith('/summary')?{unread_count:writes?0:1}:page(writes?[{...row,version:2,read_at:stamp}]:[row]);},{change:()=>{},count:()=>{},open:target=>{assert.equal(workflow.state.busy,false);assert.equal(workflow.state.pending,null);opening=target;opens++;}});
 await workflow.refresh();await workflow.open(row);assert.equal(opens,0);assert.equal(workflow.state.pending,'refresh');await workflow.recover();assert.equal(opens,1);assert.equal(writes,1);assert.equal((opening as any).row.version,3);
});
test('Unavailable/revoked open target refreshes redacted notices without a mark-read or navigation',async()=>{
 let writes=0,opens=0,leadReads=0;
 const workflow=new NotificationWorkflow(tenant,async(path,options)=>{if(options.method)writes++;if(path.endsWith('/open'))return {available:true,kind:'lead',lead_id:leadId,task_id:null};if(path===`/api/v1/leads/${leadId}`){leadReads++;throw failure(404);}return path.endsWith('/summary')?{unread_count:1}:page([{...row,current:false,can_open:false,resource_label:null}]);},{change:()=>{},count:()=>{},open:()=>opens++});
 // A previously available notification can lose resource access before the fresh open request.
 await workflow.refresh();const staleAvailable={...row};workflow.state.rows=[staleAvailable];await workflow.open(staleAvailable);assert.equal(writes,0);assert.equal(opens,0);assert.equal(leadReads,1);assert.equal(workflow.state.rows[0].resource_label,null);assert.match(workflow.state.notice,/no longer available/);
});
test('Open target validation rejects arbitrary kinds/IDs/foreign lead and scope closure blocks late navigation',async()=>{
 const ticket=new ClientRequests().capture();for(const target of [{available:true,kind:'other'},{available:true,kind:'lead',lead_id:'invalid',task_id:null},{available:false,lead_id:leadId}])await assert.rejects(()=>resolveNotificationTarget(ticket,async()=>target,tenant,id));
 await assert.rejects(()=>resolveNotificationTarget(ticket,async path=>path.endsWith('/open')?{available:true,kind:'lead',lead_id:leadId,task_id:null}:{...lead,tenant_id:crypto.randomUUID()},tenant,id));
 const delayed=deferred<unknown>();let opens=0,writes=0;const readRow={...row,read_at:stamp};const workflow=new NotificationWorkflow(tenant,async(path,options)=>{if(options.method)writes++;if(path.endsWith('/open'))return delayed.promise;return path.endsWith('/summary')?{unread_count:0}:page([readRow]);},{change:()=>{},count:()=>{},open:()=>opens++});await workflow.refresh();const pending=workflow.open(readRow);workflow.close();delayed.resolve({available:true,kind:'team'});await pending;assert.equal(opens,0);assert.equal(writes,0);
});
test('Badge summary rejects malformed/private counts and late results after ownership transfers to the inbox',async()=>{
 const requests=new ClientRequests();for(const value of [{unread_count:-1},{unread_count:'2'},{unread_count:1,private_id:id}])await assert.rejects(()=>loadNotificationSummary(requests.capture(),async()=>value,tenant));
 const delayed=deferred<unknown>(),ticket=requests.capture(),pending=loadNotificationSummary(ticket,async()=>delayed.promise,tenant);requests.close();delayed.resolve({unread_count:90});await assert.rejects(()=>pending,/scope changed/);
});
test('Notification client consumes actual SQL recipient projection, filter, replay, open and foreign-recipient denials',async()=>{
 const db=await localDatabase();try{const fixture=await seedPrivacyFixture(db),member=fixture.members[fixture.agent+fixture.agency.id];await db.exec('reset role');
 const notice=(await db.query<any>("insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,assignment_version,dedupe_key) values($1,$2,'LEAD_ASSIGNED',$3,$3,1,'notification-client-fixture') returning id",[fixture.agency.id,member,fixture.lead.id])).rows[0].id;
 await identity(db,fixture.agent);
 let lostAcknowledgement=true;
 async function transport(path:string,options:RequestInit,_tenant:string,key?:string){
  if(options.method){const value=await rpc(db,'update_notification',[fixture.agency.id,notice,JSON.parse(options.body as string),key,crypto.randomUUID()]);if(lostAcknowledgement){lostAcknowledgement=false;throw failure();}return value;}
  if(path.endsWith('/summary'))return rpc(db,'notification_summary',[fixture.agency.id]);
  if(path.endsWith('/open'))return rpc(db,'open_notification',[fixture.agency.id,notice]);
  if(path===`/api/v1/leads/${fixture.lead.id}`)return (await db.query<any>('select to_jsonb(l) row from public.leads l where id=$1',[fixture.lead.id])).rows[0].row;
  const filter=new URL(path,'https://fixture.test').searchParams.get('filter')??'ALL';const rows=(await db.query<any>('select to_jsonb(n) row from public.list_notifications($1,$2,26) n',[fixture.agency.id,filter])).rows.map(r=>r.row);return page(rows);
 }
 let opened:NotificationTarget=null;const workflow=new NotificationWorkflow(fixture.agency.id,transport,{change:()=>{},count:()=>{},open:target=>{opened=target;}});await workflow.refresh();assert.equal(workflow.state.rows.length,1);assert.equal(workflow.state.rows[0].current,true);await workflow.open(workflow.state.rows[0]);assert.equal(workflow.state.pending,'write');assert.equal(opened,null);await workflow.recover();assert.equal((opened as any).row.id,fixture.lead.id);assert.equal(workflow.state.rows[0].version,2);assert.ok(workflow.state.rows[0].read_at);
 await workflow.change(workflow.state.rows[0],'dismiss');assert.equal(workflow.state.rows.length,0);await workflow.filter('DISMISSED');assert.equal(workflow.state.rows.length,1);
 await identity(db,fixture.owner);await assert.rejects(()=>rpc(db,'open_notification',[fixture.agency.id,notice]),/NOT_FOUND/);await assert.rejects(()=>rpc(db,'update_notification',[fixture.agency.id,notice,{expected_version:1,read:true},crypto.randomUUID(),crypto.randomUUID()]),/NOT_FOUND/);
 await identity(db,fixture.other);await assert.rejects(()=>rpc(db,'notification_summary',[fixture.agency.id]),/MEMBERSHIP_REQUIRED/);
 }finally{await db.close();}
});
