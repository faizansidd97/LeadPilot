import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {localDatabase,identity,rpc,seedPrivacyFixture,migrationDir} from './helpers/local-db.ts';

test('team directory matches Supabase Auth email types without changing permissions or data',async t=>{
 let db=await localDatabase({through:22});
 try{
  const f=await seedPrivacyFixture(db);
  const source=await readFile(new URL('202610100023_team_email_type.sql',migrationDir),'utf8');
  async function definition(){await db.exec('reset role');return (await db.query<any>("select prosrc,proacl::text acl,provolatile,prosecdef,proconfig from pg_proc where oid='public.list_team_members(uuid,integer,timestamptz,uuid)'::regprocedure")).rows[0];}
  async function read(tenant=f.agency.id,limit=25,time:string|null=null,id:string|null=null){await db.exec('begin read only');try{return (await db.query<any>('select * from public.list_team_members($1,$2,$3,$4)',[tenant,limit,time,id])).rows;}finally{await db.exec('rollback');}}
  async function snapshot(){await db.exec('reset role');const rows:Record<string,unknown>={};for(const table of ['auth.users','public.memberships','public.leads','public.follow_ups','public.activity_events','private.api_requests','private.outbox_events','private.request_limits'])rows[table]=(await db.query<any>(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from ${table} t`)).rows[0].value;return rows;}
  const original=await definition();
  await t.test('reproduces the pre-upgrade return-query error with varchar(255)',async()=>{
   assert.equal((await db.query<any>("select data_type,character_maximum_length from information_schema.columns where table_schema='auth' and table_name='users' and column_name='email'")).rows[0].character_maximum_length,255);
   await identity(db,f.owner);
   assert.equal((await rpc(db,'team_snapshot',[f.agency.id])).membership.role,'OWNER');
   await db.query('select * from public.list_privacy_cases($1)',[f.agency.id]);
   await assert.rejects(()=>read(),(error:any)=>error.code==='42804');
  });
  await t.test('failed upgrade rolls back and successful replacement preserves function permissions',async()=>{
   await db.exec('reset role');await assert.rejects(()=>db.exec(source.replace('commit;','select 1/0;\ncommit;')),/division by zero/);await db.exec('rollback');assert.deepEqual(await definition(),original);
   await db.exec(source);const updated=await definition();assert.equal(updated.prosrc,original.prosrc.replace('u.email,','u.email::text,'));
   for(const key of ['acl','provolatile','prosecdef','proconfig'])assert.deepEqual(updated[key],original[key]);
  });
  await t.test('manager and agent reads, pagination and legacy text work without writes',async()=>{
   const before=await snapshot();await identity(db,f.owner);const all=await read();assert.equal(all.length,3);assert.ok(all.every(row=>typeof row.email==='string'&&row.email.endsWith('@example.test')));
   const first=await read(f.agency.id,1);const rest=await read(f.agency.id,25,first[0].created_at,first[0].id);assert.deepEqual([first[0].id,...rest.map(row=>row.id)],all.map(row=>row.id));
   await identity(db,f.admin);assert.equal((await read()).length,3);
   await identity(db,f.agent);assert.deepEqual((await read()).map(row=>row.id),[f.members[f.agent+f.agency.id]]);
   assert.deepEqual(await snapshot(),before);
   await db.exec('alter table auth.users alter column email type text');await identity(db,f.owner);assert.equal((await read()).length,3);
   await db.exec('reset role;alter table auth.users alter column email type varchar(255)');
  });
  await t.test('foreign, revoked, unverified and anonymous access remain denied after restore',async()=>{
   await identity(db,f.agent);await assert.rejects(()=>read(f.foreign.id),/MEMBERSHIP_REQUIRED/);
   await db.exec('reset role');await db.query('update public.memberships set active=false where id=$1',[f.members[f.agent+f.agency.id]]);await identity(db,f.agent);await assert.rejects(()=>read(),/MEMBERSHIP_REQUIRED/);
   await db.exec('reset role');await db.query('update auth.users set email_confirmed_at=null where id=$1',[f.admin]);await identity(db,f.admin);await assert.rejects(()=>read(),/AUTH_REQUIRED/);
   await db.exec('reset role;set role anon');await assert.rejects(()=>read(),/permission denied/);
   await db.exec('reset role');const dump=await db.dumpDataDir('none');await db.close();db=new PGlite({loadDataDir:dump});await identity(db,f.owner);assert.equal((await read()).length,3);
   await db.exec('reset role;set role anon');await assert.rejects(()=>read(),/permission denied/);
  });
 }finally{await db.close();}
});
