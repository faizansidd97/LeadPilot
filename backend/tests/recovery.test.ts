import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase,identity,rpc,seedPrivacyFixture,migrationDir} from './helpers/local-db.ts';

test('P8 isolated backup restores business data, manager review notes, replay receipts, RLS and lease fencing',async t=>{
 let db=await localDatabase();try{
 const f=await seedPrivacyFixture(db),key=crypto.randomUUID(),payload={kind:'LEAD_ERASURE',lead_id:f.lead.id,expected_version:1,reason:'Synthetic backup request'};
 const c=await rpc(db,'request_privacy_case',[f.agency.id,payload,key,crypto.randomUUID()]);
 await rpc(db,'triage_privacy_case',[f.agency.id,c.id,{action:'HOLD',expected_version:1,reason:'Synthetic preservation hold'},crypto.randomUUID(),crypto.randomUUID()]);
 await db.exec('reset role;set role service_role');
 const old=(await db.query<{id:string;lease_token:string}>('select * from public.worker_claim_notifications(1)')).rows[0];assert.ok(old);
 await db.exec('reset role');await db.query("update private.outbox_events set lease_until=now()-interval '1 second' where id=$1",[old.id]);
 const counts=(await db.query('select (select count(*)::int from public.leads) leads,(select count(*)::int from public.messages) messages,(select count(*)::int from public.activity_events) audit,(select count(*)::int from private.api_requests) receipts')).rows[0];
 const backup=await db.dumpDataDir('none');assert.ok(backup.size>0);await db.close();db=new PGlite({loadDataDir:backup});
 await t.test('dump/load preserves rows, parent references, audit and idempotency receipts',async()=>{
  const restored=(await db.query('select (select count(*)::int from public.leads) leads,(select count(*)::int from public.messages) messages,(select count(*)::int from public.activity_events) audit,(select count(*)::int from private.api_requests) receipts')).rows[0];assert.deepEqual(restored,counts);assert.equal((await db.query<{n:number}>('select count(*)::int n from public.messages m join public.leads l on (m.tenant_id,m.lead_id)=(l.tenant_id,l.id)')).rows[0].n,1);
  await identity(db,f.owner,true);const replay=await rpc(db,'request_privacy_case',[f.agency.id,payload,key,crypto.randomUUID()]);assert.equal(replay.id,c.id);assert.equal(replay.state,'ON_HOLD');assert.equal(replay.version,2);assert.equal((await db.query<any>('select reason from public.privacy_case_actions')).rows[0].reason,'Synthetic preservation hold');
 });
 await t.test('restored roles enforce independent tenant/assignment/manager privacy scope',async()=>{
  await identity(db,f.agent);assert.equal((await db.query('select id from public.leads')).rows.length,1);assert.equal((await db.query('select id from public.messages')).rows.length,1);assert.equal((await db.query('select id from public.privacy_cases')).rows.length,0);assert.equal((await db.query('select id from public.privacy_case_actions')).rows.length,0);await identity(db,f.other);assert.equal((await db.query('select id from public.messages')).rows.length,0);await assert.rejects(()=>rpc(db,'list_privacy_cases',[f.agency.id]),/MEMBERSHIP_REQUIRED/);
 });
 await t.test('expired restored leases can be reclaimed and an old completion token remains fenced',async()=>{
  await db.exec('reset role;set role service_role');const current=(await db.query<{id:string;lease_token:string}>('select * from public.worker_claim_notifications(1)')).rows[0];assert.equal(current.id,old.id);assert.notEqual(current.lease_token,old.lease_token);assert.equal((await rpc(db,'worker_finish_notification',[old.id,old.lease_token])).state,'STALE');assert.equal((await rpc(db,'worker_finish_notification',[current.id,current.lease_token])).state,'SUCCEEDED');
 });
 }finally{await db.close();}
});
test('P8 migration failure rolls back new tables, RLS policies and changed permission helpers',async()=>{
 const db=await localDatabase({through:13});try{
  const source=await readFile(new URL('202610070014_hardening.sql',migrationDir),'utf8');
  const prior=(await db.query<{body:string}>("select prosrc body from pg_proc where oid='private.has_membership(uuid)'::regprocedure")).rows[0].body;
  await assert.rejects(()=>db.exec(source.replace(/commit;\s*$/,"select 1/0;\ncommit;")),/division by zero/);await db.exec('rollback');
  assert.equal((await db.query<{t:string|null}>("select to_regclass('public.privacy_cases')::text t")).rows[0].t,null);assert.equal((await db.query<{n:number}>("select count(*)::int n from pg_policies where policyname='verified_membership_read'")).rows[0].n,0);assert.equal((await db.query<{body:string}>("select prosrc body from pg_proc where oid='private.has_membership(uuid)'::regprocedure")).rows[0].body,prior);
  await db.exec(source);assert.equal((await db.query<{t:string|null}>("select to_regclass('public.privacy_cases')::text t")).rows[0].t,'privacy_cases');
 }finally{await db.close();}
});
