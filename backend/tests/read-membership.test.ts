import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {localDatabase,identity,rpc,seedPrivacyFixture,migrationDir} from './helpers/local-db.ts';

test('read RPCs work in real READ ONLY transactions without weakening mutation or tenant authority',async t=>{
 // Isolate the historical locking defect; Supabase email compatibility is tested separately.
 let db=await localDatabase({through:20,legacyAuthEmailText:true});
 try{
  const f=await seedPrivacyFixture(db);
  const migration=await readFile(new URL('202610100021_read_membership.sql',migrationDir),'utf8');
  async function readOnly<T>(action:()=>Promise<T>){await db.exec('begin read only');try{return await action();}finally{await db.exec('rollback');}}
  async function definitions(){await db.exec('reset role');return (await db.query<any>("select p.oid::regprocedure::text signature,p.prosrc,p.proacl::text acl,p.provolatile,p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by signature")).rows;}
  async function snapshot(){await db.exec('reset role');const result:Record<string,unknown>={};for(const table of ['public.memberships','public.leads','public.follow_ups','public.notifications','public.activity_events','private.api_requests','private.outbox_events','private.request_limits'])result[table]=(await db.query<any>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;return result;}
  const original=await definitions();
  await t.test('the existing directory reproduces SQLSTATE 25006 in the hosted transaction mode',async()=>{
   await identity(db,f.owner);
   await assert.rejects(()=>readOnly(()=>db.query('select * from public.list_assignment_members($1)',[f.agency.id])),(error:any)=>error.code==='25006');
   await assert.rejects(()=>readOnly(()=>rpc(db,'dashboard_summary',[f.agency.id,null,null])),(error:any)=>error.code==='25006');
  });
  await t.test('a failed upgrade rolls back every replacement and the private helper',async()=>{
   await db.exec('reset role');
   await assert.rejects(()=>db.exec(migration.replace('commit;','select 1/0;\ncommit;')),/division by zero/);await db.exec('rollback');
   assert.deepEqual(await definitions(),original);
   assert.equal((await db.query<any>("select to_regprocedure('private.read_member(uuid)') value")).rows[0].value,null);
   await db.exec(migration);
  });
  await t.test('directory, team, dashboard, operations and CRM reads succeed without changing persisted state',async()=>{
   const before=await snapshot();await identity(db,f.owner,true);
   await readOnly(async()=>{
    assert.equal((await db.query('select * from public.list_assignment_members($1)',[f.agency.id])).rows.length,3);
    assert.equal((await db.query('select * from public.list_team_members($1)',[f.agency.id])).rows.length,3);
    assert.equal((await rpc(db,'team_snapshot',[f.agency.id])).membership.role,'OWNER');
    assert.equal((await rpc(db,'dashboard_summary',[f.agency.id,null,null])).metrics.total,1);
    assert.equal((await rpc(db,'agency_operations_snapshot',[f.agency.id])).scheduler_verified,false);
    for(const name of ['analysis_usage','draft_feedback_summary','list_lead_imports','list_website_integrations','notification_summary'])await rpc(db,name,[f.agency.id]);
    await db.query('select * from public.list_notifications($1)',[f.agency.id]);
    await db.query('select * from public.list_team_invitations($1)',[f.agency.id]);
    await db.query('select * from public.list_privacy_cases($1)',[f.agency.id]);
    await rpc(db,'duplicate_candidates',[f.agency.id,f.lead.id]);
   });
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('manager key selection remains read-only and returns the configured legacy policies',async()=>{
   await identity(db,f.owner,true);
   await readOnly(async()=>{
    assert.equal(await rpc(db,'integration_encryption_key',[f.agency.id]),'legacy');
    assert.equal(await rpc(db,'integration_signing_root',[f.agency.id,'create',null,crypto.randomUUID()]),'legacy');
    assert.equal(await rpc(db,'invitation_signing_key',[f.agency.id,'create',null,crypto.randomUUID(),{email:'fixture@example.test',role:'AGENT'}]),'legacy');
   });
   await identity(db,f.agent);
   await assert.rejects(()=>readOnly(()=>rpc(db,'integration_encryption_key',[f.agency.id])),/ROLE_REQUIRED/);
  });
  await t.test('shared-user roles, foreign tenants and revoked or unverified identity still fail closed',async()=>{
   await identity(db,f.owner);
   assert.equal((await readOnly(()=>db.query<any>('select * from public.list_assignment_members($1)',[f.foreign.id]))).rows.length,1);
   await identity(db,f.agent);
   const self=await readOnly(()=>db.query<any>('select * from public.list_assignment_members($1)',[f.agency.id]));assert.equal(self.rows.length,1);assert.equal(self.rows[0].id,f.members[f.agent+f.agency.id]);
   await assert.rejects(()=>readOnly(()=>rpc(db,'dashboard_summary',[f.foreign.id,null,null])),/MEMBERSHIP_REQUIRED/);
   await db.exec('reset role');await db.query('update public.memberships set active=false where id=$1',[f.members[f.agent+f.agency.id]]);await identity(db,f.agent);
   await assert.rejects(()=>readOnly(()=>db.query('select * from public.list_assignment_members($1)',[f.agency.id])),/MEMBERSHIP_REQUIRED/);
   await db.exec('reset role');await db.query('update public.memberships set active=true where id=$1',[f.members[f.agent+f.agency.id]]);await db.query('update auth.users set email_confirmed_at=null where id=$1',[f.agent]);await identity(db,f.agent);
   await assert.rejects(()=>readOnly(()=>db.query('select * from public.list_assignment_members($1)',[f.agency.id])),/AUTH_REQUIRED/);
   await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=now() where id=$1',[f.agent]);
  });
  await t.test('the private helper has no public or user execution grant and existing function ACLs are identical',async()=>{
   const changed=await definitions();for(const prior of original){const now=changed.find(row=>row.signature===prior.signature);assert.ok(now);assert.equal(now.acl,prior.acl);assert.equal(now.provolatile,prior.provolatile);assert.equal(now.prosecdef,prior.prosecdef);}
   for(const role of ['anon','authenticated']){await db.exec('reset role');await db.exec('set role '+role);await assert.rejects(()=>readOnly(()=>db.query('select private.read_member($1)',[f.agency.id])),/permission denied/);}
  });
  await t.test('writer and replay membership locks remain byte-identical and ordinary writes still work',async()=>{
   const after=await definitions();for(const signature of ['private.active_member(uuid)','private.writer_member(uuid)','public.create_agency(jsonb,uuid,uuid)'])assert.deepEqual(after.find(row=>row.signature===signature),original.find(row=>row.signature===signature));
   await identity(db,f.owner);const key=crypto.randomUUID(),input={full_name:'Read recovery fixture',email:'read-recovery@example.test',initial_message:'Synthetic test inquiry'};
   const lead=await rpc(db,'create_lead',[f.agency.id,input,key,crypto.randomUUID()]);assert.equal(lead.full_name,input.full_name);
   assert.equal((await rpc(db,'create_lead',[f.agency.id,input,key,crypto.randomUUID()])).id,lead.id);
   await assert.rejects(()=>readOnly(()=>rpc(db,'create_lead',[f.agency.id,{full_name:'Blocked write',email:'blocked@example.test'},crypto.randomUUID(),crypto.randomUUID()])),(error:any)=>error.code==='25006');
  });
  await t.test('restored database retains read-only compatibility and private helper permissions',async()=>{
   await db.exec('reset role');const dump=await db.dumpDataDir('none');await db.close();
   const {PGlite}=await import('@electric-sql/pglite');db=new PGlite({loadDataDir:dump});
   await identity(db,f.owner);await db.exec('begin read only');assert.ok((await db.query('select * from public.list_assignment_members($1)',[f.agency.id])).rows.length>0);await db.exec('rollback');await assert.rejects(()=>db.query('select private.read_member($1)',[f.agency.id]),/permission denied/);
  });
 }finally{await db.close();}
});
