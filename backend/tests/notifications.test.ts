import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {invitationToken,tokenHash} from '../src/server/invitations.ts';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
test('durable notices enforce recipient scope, current access, catch-up, lease fencing and recovery',async t=>{
 const db=new PGlite();const owner=crypto.randomUUID(),admin=crypto.randomUUID(),agent=crypto.randomUUID(),agent2=crypto.randomUUID(),outside=crypto.randomUUID();
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,email text);create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;grant usage on schema auth to authenticated;`);
 for(const id of [owner,admin,agent,agent2,outside])await db.query('insert into auth.users values($1,now(),$2)',[id,id+'@example.com']);
 const dir=new URL('../supabase/migrations/',import.meta.url);for(const name of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,dir),'utf8'));
 async function as(id:string){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role authenticated');}
 async function worker(){await db.exec('reset role');await db.exec('set role service_role');}
 async function system(){await db.exec('reset role');}
 async function rpc(name:string,args:unknown[]=[]){return(await db.query<{result:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args)).rows[0].result;}
 async function claim(limit=20){return(await db.query<{id:string;lease_token:string;event_type:string}>('select * from public.worker_claim_notifications($1)',[limit])).rows;}
 async function drain(){await worker();for(let i=0;i<30;i++){const rows=await claim();if(!rows.length)return;for(const job of rows)if(job.event_type==='INVITATION_MAIL')await rpc('worker_complete_invitation_mail',[job.id,job.lease_token,'LINK_ONLY']);else await rpc('worker_finish_notification',[job.id,job.lease_token]);}throw new Error('Fixture queue did not drain');}
 async function notices(tenant:string,filter='ALL'){return(await db.query<any>('select * from public.list_notifications($1,$2)',[tenant,filter])).rows;}
 await as(owner);const a=(await rpc('create_agency',[{name:'Notice Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await as(outside);const b=(await rpc('create_agency',[{name:'Other Agency'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await system();const members:Record<string,string>={};for(const [id,role] of [[admin,'ADMIN'],[agent,'AGENT'],[agent2,'AGENT']])members[id]=(await db.query<{id:string}>('insert into public.memberships(tenant_id,user_id,role) values($1,$2,$3) returning id',[a.id,id,role])).rows[0].id;
 const ownerMember=(await db.query<{id:string}>('select id from public.memberships where tenant_id=$1 and user_id=$2',[a.id,owner])).rows[0].id;
 await db.query("insert into public.memberships(tenant_id,user_id,role) values($1,$2,'AGENT')",[b.id,owner]);
 await as(agent);let lead=await rpc('create_lead',[a.id,{full_name:'Notice Buyer',email:'notice@example.com'},crypto.randomUUID(),crypto.randomUUID()]);let initialNotice:string;let dueTask:any;let queueLead:any;
 async function task(target:any,type='CALL'){const result=await rpc('create_follow_up',[a.id,{lead_id:target.id,type,title:'Follow up',due_at:new Date(Date.now()+86400000).toISOString(),expected_lead_version:target.version},crypto.randomUUID(),crypto.randomUUID()]);target.version=result.lead_version;return result.follow_up;}
 async function overdue(id:string){await system();await db.query("update public.follow_ups set due_at=now()-interval '1 hour' where id=$1",[id]);}
 await t.test('workers and tables deny user/anonymous writes; notices are recipient-only across tenants and roles',async()=>{
  await assert.rejects(()=>rpc('worker_seed_due'),/permission denied/);await assert.rejects(()=>db.query('select * from private.outbox_events'),/permission denied/);
  await drain();await as(agent);const rows=await notices(a.id);assert.equal(rows.length,1);initialNotice=rows[0].id;assert.equal(rows[0].resource_label,'Notice Buyer');assert.equal(rows[0].current,true);
  await assert.rejects(()=>db.query("update public.notifications set read_at=now() where id=$1",[initialNotice]),/permission denied/);
  await as(owner);assert.equal((await notices(a.id)).length,0);assert.equal((await db.query('select * from public.notifications where id=$1',[initialNotice])).rows.length,0);
  await assert.rejects(()=>rpc('update_notification',[a.id,initialNotice,{expected_version:1,read:true},crypto.randomUUID(),crypto.randomUUID()]),/NOT_FOUND/);
  await assert.rejects(()=>rpc('open_notification',[a.id,initialNotice]),/NOT_FOUND/);assert.equal((await notices(b.id)).length,0);
  await as(outside);await assert.rejects(()=>notices(a.id),/MEMBERSHIP_REQUIRED/);
  await system();await db.exec('set role anon');await assert.rejects(()=>rpc('worker_notification_metrics'),/permission denied/);
 });
 await t.test('assignment versions suppress delayed and cyclic assignments without hiding the latest authorized resource',async()=>{
  await as(owner);lead=(await rpc('mutate_lead_control',[a.id,lead.id,'assignment',{expected_version:lead.version,assignee_id:members[agent2],reason:'Reassign to agent two'},crypto.randomUUID(),crypto.randomUUID()])).lead;
  await drain();await as(agent);let old=(await notices(a.id)).find((n:any)=>n.id===initialNotice);assert.equal(old.current,false);assert.equal(old.resource_label,null);assert.equal(old.can_open,false);assert.deepEqual(await rpc('open_notification',[a.id,initialNotice]),{available:false});
  await as(agent2);assert.equal((await notices(a.id)).filter((n:any)=>n.current).length,1);
  await as(owner);lead=(await rpc('mutate_lead_control',[a.id,lead.id,'assignment',{expected_version:lead.version,assignee_id:members[agent],reason:'Return current assignment'},crypto.randomUUID(),crypto.randomUUID()])).lead;
  await drain();await as(agent);old=(await notices(a.id)).find((n:any)=>n.id===initialNotice);assert.equal(old.current,false);assert.equal(old.resource_label,null);assert.equal(old.can_open,true);assert.equal((await rpc('open_notification',[a.id,initialNotice])).lead_id,lead.id);assert.equal((await notices(a.id)).filter((n:any)=>n.current).length,1);
 });
 await t.test('late scans catch up exactly once per task/schedule/recipient and measure unprocessed lag',async()=>{
  await as(agent);dueTask=await task(lead);await overdue(dueTask.id);await worker();let metrics=await rpc('worker_notification_metrics');assert.ok(metrics.due_lag_seconds>=3500);assert.equal(metrics.alert,true);
  assert.equal((await rpc('worker_seed_due')).seeded,1);assert.equal((await rpc('worker_seed_due')).seeded,0);await drain();await as(agent);const rows=(await notices(a.id)).filter((n:any)=>n.type==='FOLLOW_UP_DUE');assert.equal(rows.length,1);assert.equal(rows[0].current,true);
  await worker();assert.equal((await rpc('worker_seed_due')).seeded,0);metrics=await rpc('worker_notification_metrics');assert.equal(metrics.due_lag_seconds,0);assert.equal(metrics.failed_jobs,0);
 });
 await t.test('manager queue fans out separately; managers cannot read or dismiss each other’s notices',async()=>{
  await as(owner);queueLead=await rpc('create_lead',[a.id,{full_name:'Queue Buyer',email:'queue@example.com'},crypto.randomUUID(),crypto.randomUUID()]);const queued=await task(queueLead);await overdue(queued.id);await worker();assert.equal((await rpc('worker_seed_due')).seeded,2);await drain();
  await as(owner);const own=(await notices(a.id)).find((n:any)=>n.type==='FOLLOW_UP_DUE');assert.ok(own);await as(admin);const theirs=(await notices(a.id)).find((n:any)=>n.type==='FOLLOW_UP_DUE');assert.ok(theirs);assert.notEqual(own.id,theirs.id);assert.equal((await db.query('select * from public.notifications where id=$1',[own.id])).rows.length,0);
  await assert.rejects(()=>rpc('update_notification',[a.id,own.id,{expected_version:1,dismiss:true},crypto.randomUUID(),crypto.randomUUID()]),/NOT_FOUND/);
 });
 await t.test('duplicate review and invite acceptance emit only permitted manager/inviter notices',async()=>{
  await as(agent);const duplicate=await rpc('create_lead',[a.id,{full_name:'Duplicate Review Buyer',email:'notice@example.com'},crypto.randomUUID(),crypto.randomUUID()]);assert.equal(duplicate.duplicate_review,true);await drain();await as(owner);const review=(await notices(a.id)).find((n:any)=>n.type==='MANAGER_REVIEW'&&n.resource_label==='Duplicate Review Buyer');assert.ok(review);await as(agent);assert.equal((await notices(a.id)).some((n:any)=>n.type==='MANAGER_REVIEW'),false);
  await system();await db.query('update public.leads set duplicate_review=false where id=$1',[duplicate.id]);await as(owner);assert.equal((await notices(a.id)).find((n:any)=>n.id===review.id).resource_label,null);
  const invitee=crypto.randomUUID(),token='a'.repeat(64),digest=createHash('sha256').update(token).digest('hex');await system();await db.query('insert into auth.users values($1,now(),$2)',[invitee,'invited@example.com']);await db.query('update public.agencies set seat_limit=8 where id=$1',[a.id]);await as(owner);await rpc('create_team_invitation',[a.id,{email:'invited@example.com',role:'AGENT'},digest,crypto.randomUUID(),crypto.randomUUID()]);await as(invitee);await rpc('accept_team_invitation',[digest,'Invited Agent',crypto.randomUUID(),crypto.randomUUID()]);await drain();await as(owner);const joined=(await notices(a.id)).find((n:any)=>n.type==='INVITE_ACCEPTED');assert.ok(joined);assert.equal((await rpc('open_notification',[a.id,joined.id])).kind,'team');await as(admin);assert.equal((await notices(a.id)).some((n:any)=>n.type==='INVITE_ACCEPTED'),false);
 });
 await t.test('invitation mail queues atomically without a raw token, dedupes replay and suppresses revoked/resend links',async()=>{
  await as(owner);const key=crypto.randomUUID(),secret='c'.repeat(64),raw=invitationToken(secret,a.id,owner,'create:',key),fields={email:'queued-mail@example.com',role:'AGENT'};
  const invite=await rpc('create_team_invitation',[a.id,fields,tokenHash(raw),key,crypto.randomUUID()]);await rpc('create_team_invitation',[a.id,fields,tokenHash(raw),key,crypto.randomUUID()]);assert.equal((await rpc('invitation_delivery_state',[a.id,invite.id,key])).state,'PENDING');await as(agent);await assert.rejects(()=>rpc('invitation_delivery_state',[a.id,invite.id,key]),/ROLE_REQUIRED/);
  await system();const rows=(await db.query<{id:string;payload:any}>("select id,payload from private.outbox_events where entity_id=$1 and event_type='INVITATION_MAIL'",[invite.id])).rows;assert.equal(rows.length,1);assert.equal(JSON.stringify(rows).includes(raw),false);
  await worker();let job=(await claim(1))[0];assert.equal(job.id,rows[0].id);let prepared=await rpc('worker_prepare_invitation_mail',[job.id,job.lease_token]);assert.equal(prepared.available,true);assert.equal(prepared.to,fields.email);assert.equal(prepared.token,undefined);
  await as(owner);await rpc('change_team_invitation',[a.id,invite.id,'revoke',{expected_version:1},null,crypto.randomUUID(),crypto.randomUUID()]);await worker();assert.equal((await rpc('worker_prepare_invitation_mail',[job.id,job.lease_token])).available,false);await rpc('worker_complete_invitation_mail',[job.id,job.lease_token,'INVITATION_UNAVAILABLE']);
  await as(owner);const older=await rpc('create_team_invitation',[a.id,{email:'resend-mail@example.com',role:'AGENT'},tokenHash('9'.repeat(64)),crypto.randomUUID(),crypto.randomUUID()]);await rpc('change_team_invitation',[a.id,older.id,'resend',{expected_version:1},tokenHash('8'.repeat(64)),crypto.randomUUID(),crypto.randomUUID()]);await worker();const pending=await claim();assert.equal(pending.length,2);let availableCount=0;
  for(job of pending){prepared=await rpc('worker_prepare_invitation_mail',[job.id,job.lease_token]);availableCount+=Number(prepared.available);await rpc('worker_complete_invitation_mail',[job.id,job.lease_token,prepared.available?'EMAIL_ACCEPTED':'INVITATION_UNAVAILABLE']);}assert.equal(availableCount,1);
  await as(owner);const listing=(await db.query<any>('select * from public.list_team_invitations($1)',[a.id])).rows.find(i=>i.id===older.id);assert.equal(listing.delivery_state,'EMAIL_ACCEPTED');assert.equal(listing.token_hash,undefined);
  // Equal request UUIDs across different actors are separate legitimate operations.
  const shared=crypto.randomUUID();const scoped=await rpc('create_team_invitation',[a.id,{email:'scoped-mail@example.com',role:'AGENT'},tokenHash('6'.repeat(64)),crypto.randomUUID(),crypto.randomUUID()]);
  await as(admin);await rpc('change_team_invitation',[a.id,scoped.id,'resend',{expected_version:1},tokenHash('5'.repeat(64)),shared,crypto.randomUUID()]);await as(owner);await rpc('change_team_invitation',[a.id,scoped.id,'resend',{expected_version:2},tokenHash('4'.repeat(64)),shared,crypto.randomUUID()]);
  await system();assert.equal((await db.query("select * from private.outbox_events where entity_id=$1 and event_type='INVITATION_MAIL'",[scoped.id])).rows.length,3);await drain();
 });
 await t.test('failed business audit or outbox capture rolls back the invitation/lead and its durable side effect',async()=>{
  await system();await db.exec(`create function public.fail_operation_audit() returns trigger language plpgsql as $$ begin raise exception 'AUDIT_BLOCK';end $$;create trigger fail_operation_audit before insert on public.activity_events for each row execute function public.fail_operation_audit();`);await as(owner);
  await assert.rejects(()=>rpc('create_team_invitation',[a.id,{email:'rollback-mail@example.com',role:'AGENT'},tokenHash('7'.repeat(64)),crypto.randomUUID(),crypto.randomUUID()]),/AUDIT_BLOCK/);await system();assert.equal((await db.query("select * from public.invitations where email='rollback-mail@example.com'")).rows.length,0);await db.exec('drop trigger fail_operation_audit on public.activity_events');
  await db.exec(`create function public.fail_outbox_capture() returns trigger language plpgsql as $$ begin raise exception 'OUTBOX_BLOCK';end $$;create trigger fail_outbox_capture before insert on private.outbox_events for each row execute function public.fail_outbox_capture();`);await as(owner);const key=crypto.randomUUID();await assert.rejects(()=>rpc('create_lead',[a.id,{full_name:'Rollback Buyer',email:'rollback-notice@example.com',initial_message:'Initial inquiry'},key,crypto.randomUUID()]),/OUTBOX_BLOCK/);
  await system();assert.equal((await db.query("select * from public.leads where email='rollback-notice@example.com'")).rows.length,0);assert.equal((await db.query('select * from private.api_requests where request_key=$1',[key])).rows.length,0);await db.exec('drop trigger fail_outbox_capture on private.outbox_events');
 });
 await t.test('privileged workers recheck tenant parents and role even if an execute grant is accidentally widened',async()=>{
  await as(outside);const other=await rpc('create_lead',[b.id,{full_name:'Other Buyer',email:'other@example.com'},crypto.randomUUID(),crypto.randomUUID()]);const otherTask=(await rpc('create_follow_up',[b.id,{lead_id:other.id,type:'CALL',title:'Other task',due_at:new Date(Date.now()+86400000).toISOString(),expected_lead_version:1},crypto.randomUUID(),crypto.randomUUID()])).follow_up;await drain();await system();
  const bad=(await db.query<{id:string}>("insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values($1,'FOLLOW_UP_DUE',$2,'cross-tenant-test',$3) returning id",[a.id,otherTask.id,{recipient_id:members[agent],schedule_version:1,lead_id:lead.id}])).rows[0].id;await worker();const job=(await claim(1))[0];assert.equal(job.id,bad);assert.equal((await rpc('worker_finish_notification',[job.id,job.lease_token])).state,'CANCELLED');
  await system();assert.equal((await db.query('select * from public.notifications where task_id=$1',[otherTask.id])).rows.length,0);await db.exec('grant execute on function public.worker_seed_due(integer) to authenticated');await as(owner);await assert.rejects(()=>rpc('worker_seed_due'),/WORKER_REQUIRED/);await system();await db.exec('revoke execute on function public.worker_seed_due(integer) from authenticated');
 });
 await t.test('reschedule, contact restriction and completion invalidate queued schedules while INTERNAL remains eligible',async()=>{
  await as(agent);const changed=await task(lead);await overdue(changed.id);await worker();await rpc('worker_seed_due');await as(agent);
  const rescheduled=await rpc('change_follow_up',[a.id,changed.id,'reschedule',{expected_version:1,due_at:new Date(Date.now()+172800000).toISOString(),reason:'Customer changed appointment'},crypto.randomUUID(),crypto.randomUUID()]);lead.version=rescheduled.lead_version;
  await drain();await system();assert.equal((await db.query('select * from public.notifications where task_id=$1',[changed.id])).rows.length,0);
  await as(agent);const internal=await task(lead,'INTERNAL');await overdue(internal.id);await as(agent);lead=(await rpc('mutate_lead_control',[a.id,lead.id,'contact-preference',{expected_version:lead.version,do_not_contact:true,reason:'Customer requested no contact'},crypto.randomUUID(),crypto.randomUUID()])).lead;
  await worker();await rpc('worker_seed_due');await drain();await as(agent);const rows=await notices(a.id);assert.equal(rows.filter((n:any)=>n.type==='FOLLOW_UP_DUE'&&n.current).length,1);
  const done=await rpc('change_follow_up',[a.id,internal.id,'complete',{expected_version:1,summary:'Internal review completed'},crypto.randomUUID(),crypto.randomUUID()]);lead.version=done.lead_version;
  assert.equal((await notices(a.id)).filter((n:any)=>n.type==='FOLLOW_UP_DUE'&&n.current).length,0);
 });
 await t.test('expired leases recover with a new fencing token; stale finish/fail cannot publish or overwrite',async()=>{
  await as(agent2);const fresh=await rpc('create_lead',[a.id,{full_name:'Lease Buyer',email:'lease@example.com'},crypto.randomUUID(),crypto.randomUUID()]);await worker();const first=(await claim(1))[0];assert.ok(first);
  assert.equal((await rpc('worker_finish_notification',[first.id,crypto.randomUUID()])).state,'STALE');await system();await db.query("update private.outbox_events set lease_until=now()-interval '1 second' where id=$1",[first.id]);await worker();const second=(await claim(1))[0];assert.equal(second.id,first.id);assert.notEqual(second.lease_token,first.lease_token);
  assert.equal((await rpc('worker_finish_notification',[first.id,first.lease_token])).state,'STALE');assert.equal((await rpc('worker_fail_notification',[first.id,first.lease_token])).state,'STALE');assert.equal((await rpc('worker_finish_notification',[second.id,second.lease_token])).state,'SUCCEEDED');
  await system();assert.equal((await db.query<{count:number}>('select count(*)::int as count from public.notifications where lead_id=$1',[fresh.id])).rows[0].count,1);
 });
 await t.test('write failures roll back publication; three attempts exhaust, explicit recovery is audited and deduped',async()=>{
  await as(agent2);const target=await rpc('create_lead',[a.id,{full_name:'Recovery Buyer',email:'recovery@example.com'},crypto.randomUUID(),crypto.randomUUID()]);const targetTask=await task(target);await overdue(targetTask.id);await drain();await worker();await rpc('worker_seed_due');let job=(await claim(1))[0];assert.equal(job.event_type,'FOLLOW_UP_DUE');
  await system();await db.exec(`create function public.fail_notice_insert() returns trigger language plpgsql as $$ begin raise exception 'WRITE_FAIL';end $$;create trigger fail_notice_insert before insert on public.notifications for each row execute function public.fail_notice_insert();`);
  for(let attempt=1;attempt<=3;attempt++){await worker();await assert.rejects(()=>rpc('worker_finish_notification',[job.id,job.lease_token]),/WRITE_FAIL/);const result=await rpc('worker_fail_notification',[job.id,job.lease_token]);assert.equal(result.state,attempt===3?'FAILED':'PENDING');
   await system();const persisted=(await db.query<{attempts:number;next:number}>('select attempts,extract(epoch from available_at-now())::int as next from private.outbox_events where id=$1',[job.id])).rows[0];assert.equal(persisted.attempts,attempt);assert.ok(persisted.next>=30*Math.pow(2,attempt-1)-2);assert.equal((await db.query('select * from public.notifications where task_id=$1',[targetTask.id])).rows.length,0);
   if(attempt<3){await db.query("update private.outbox_events set available_at=now()-interval '1 second' where id=$1",[job.id]);await worker();job=(await claim(1))[0];}
  }
  await worker();assert.equal((await rpc('worker_notification_metrics')).failed_jobs,1);await assert.rejects(()=>rpc('worker_requeue_notification',[job.id,2,crypto.randomUUID()]),/VERSION_CONFLICT/);
  await system();await db.exec('drop trigger fail_notice_insert on public.notifications');await worker();await rpc('worker_requeue_notification',[job.id,3,crypto.randomUUID()]);const recovered=(await claim(1))[0];assert.equal((await rpc('worker_finish_notification',[recovered.id,recovered.lease_token])).state,'SUCCEEDED');assert.equal((await rpc('worker_finish_notification',[recovered.id,recovered.lease_token])).state,'STALE');
  await system();assert.equal((await db.query<{state:string}>('select state from public.follow_ups where id=$1',[targetTask.id])).rows[0].state,'OPEN');assert.equal((await db.query('select * from public.notifications where task_id=$1',[targetTask.id])).rows.length,1);assert.equal((await db.query("select * from public.activity_events where event_type='NOTIFICATION_JOB_REQUEUED'")).rows.length,1);
 });
 await t.test('read/dismiss uses recipient, version and replay checks and preserves input after conflicts',async()=>{
  await as(agent);const row=(await notices(a.id))[0],key=crypto.randomUUID(),payload={expected_version:row.version,read:true};const result=await rpc('update_notification',[a.id,row.id,payload,key,crypto.randomUUID()]);assert.ok(result.read_at);assert.equal(result.version,row.version+1);assert.equal((await rpc('update_notification',[a.id,row.id,payload,key,crypto.randomUUID()])).version,result.version);
  await assert.rejects(()=>rpc('update_notification',[a.id,row.id,{expected_version:row.version,dismiss:true},crypto.randomUUID(),crypto.randomUUID()]),/VERSION_CONFLICT/);await assert.rejects(()=>rpc('update_notification',[a.id,row.id,{expected_version:result.version,dismiss:true,recipient_id:ownerMember},crypto.randomUUID(),crypto.randomUUID()]),/VALIDATION_FAILED/);
  await rpc('update_notification',[a.id,row.id,{expected_version:result.version,dismiss:true},crypto.randomUUID(),crypto.randomUUID()]);assert.equal((await notices(a.id)).some((n:any)=>n.id===row.id),false);assert.equal((await notices(a.id,'DISMISSED')).some((n:any)=>n.id===row.id),true);assert.ok((await rpc('notification_summary',[a.id])).unread_count>=0);
 });
 await t.test('offboarding removes old access and directs due work to the replacement schedule',async()=>{
  await as(owner);await rpc('change_team_member',[a.id,members[agent2],{expected_version:1,active:false,transfer_workload:true,replacement_id:members[agent],reason:'Transfer departing agent workload'},crypto.randomUUID(),crypto.randomUUID()]);await as(agent2);await assert.rejects(()=>rpc('notification_summary',[a.id]),/MEMBERSHIP_REQUIRED/);assert.equal((await db.query('select * from public.notifications')).rows.length,0);
  await worker();const result=await rpc('worker_seed_due');assert.ok(result.seeded>0);await drain();await as(agent);assert.ok((await notices(a.id)).some((n:any)=>n.type==='FOLLOW_UP_DUE'&&n.current));
 });
 await t.test('scans/claims and large manager fan-out stay bounded and continuation does not exhaust retries',async()=>{
  await system();await db.query("update public.follow_ups set state='CANCELLED' where tenant_id=$1",[a.id]);
  await db.query("insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,due_at,created_by) select $1,$2,null,'INTERNAL','Batch task',now()-interval '1 hour',$3 from generate_series(1,120)",[a.id,queueLead.id,owner]);
  await worker();await assert.rejects(()=>rpc('worker_seed_due',[101]),/VALIDATION_FAILED/);await assert.rejects(()=>claim(21),/VALIDATION_FAILED/);
  assert.equal((await rpc('worker_seed_due',[100])).seeded,100);assert.equal((await rpc('worker_seed_due',[100])).seeded,100);assert.equal((await rpc('worker_seed_due',[100])).seeded,40);assert.equal((await rpc('worker_seed_due',[100])).seeded,0);await drain();
  await system();await db.query("update public.follow_ups set state='CANCELLED' where tenant_id=$1",[a.id]);
  for(let i=0;i<101;i++){const id=crypto.randomUUID();await db.query('insert into auth.users values($1,now(),$2)',[id,id+'@example.com']);await db.query("insert into public.memberships(tenant_id,user_id,role) values($1,$2,'ADMIN')",[a.id,id]);}
  await as(owner);const fanout=await rpc('create_lead',[a.id,{full_name:'Large Manager Queue',email:'fanout@example.com'},crypto.randomUUID(),crypto.randomUUID()]);await worker();let job=(await claim(1))[0];const page=await rpc('worker_finish_notification',[job.id,job.lease_token]);assert.equal(page.state,'PENDING');assert.equal(page.written,100);job=(await claim(1))[0];const final=await rpc('worker_finish_notification',[job.id,job.lease_token]);assert.equal(final.state,'SUCCEEDED');assert.equal(final.written,3);
  await system();assert.equal((await db.query<{count:number}>('select count(*)::int as count from public.notifications where lead_id=$1',[fanout.id])).rows[0].count,103);
 });
 await t.test('three abandoned leases exhaust visibly and cannot silently restart on the next scan',async()=>{
  await system();const row=(await db.query<{id:string}>("insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key) values($1,'AGENCY_SETTINGS_CHANGED',$1,'lease-exhaustion') returning id",[a.id])).rows[0];
  for(let i=0;i<3;i++){await worker();const job=(await claim(1))[0];assert.equal(job.id,row.id);await system();await db.query("update private.outbox_events set lease_until=now()-interval '1 second' where id=$1",[row.id]);}
  await worker();assert.equal((await claim(1)).length,0);assert.equal((await rpc('worker_notification_metrics')).failed_jobs,1);await system();const stored=(await db.query<{state:string;last_error_code:string}>('select state,last_error_code from private.outbox_events where id=$1',[row.id])).rows[0];assert.equal(stored.state,'FAILED');assert.equal(stored.last_error_code,'LEASE_EXHAUSTED');
 });
 await t.test('HTTP limits are shared across agencies, bounded, independent by kind and durable after denial',async()=>{
  await as(outside);await db.exec('begin');for(let i=0;i<60;i++)assert.equal((await rpc('consume_http_limit',['read'])).allowed,true);let limit=await rpc('consume_http_limit',['read']);assert.equal(limit.allowed,false);assert.ok(limit.retry_after>=1&&limit.retry_after<=60);assert.equal((await rpc('consume_http_limit',['read'])).allowed,false);
  for(let i=0;i<30;i++)assert.equal((await rpc('consume_http_limit',['mutation'])).allowed,true);assert.equal((await rpc('consume_http_limit',['mutation'])).allowed,false);await db.exec('commit');await assert.rejects(()=>db.query('select * from private.request_limits'),/permission denied/);
  await system();await db.query("insert into private.request_limits values($1,'DB_MUTATION',date_trunc('minute',now()),30) on conflict(actor_id,kind,window_at) do update set count=30",[agent]);await as(agent);await assert.rejects(()=>rpc('create_lead',[a.id,{full_name:'Blocked Buyer',email:'blocked@example.com'},crypto.randomUUID(),crypto.randomUUID()]),/RATE_LIMITED/);
  await system();assert.equal((await db.query("select * from public.leads where email='blocked@example.com'")).rows.length,0);
  await db.query("insert into private.request_limits select $1,'HTTP_READ',date_trunc('minute',now())-interval '3 hours'-i*interval '1 minute',1 from generate_series(1,140) i",[outside]);await worker();assert.equal((await rpc('worker_notification_metrics')).cleaned_limit_windows,100);assert.equal((await rpc('worker_notification_metrics')).cleaned_limit_windows,40);
 });
 }finally{await db.close();}
});
