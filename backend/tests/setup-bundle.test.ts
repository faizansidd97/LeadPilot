import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('fresh setup bundle matches all numbered migrations, applies atomically and refuses existing business tables',async()=>{
 const db=new PGlite();try{await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz,email varchar(255));create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;grant usage on schema auth to authenticated;`);
 const bundle=await readFile(new URL('../supabase/setup.sql',import.meta.url),'utf8');
 const files=(await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(name=>/^\d+_.+\.sql$/.test(name)).sort();
 assert.deepEqual([...bundle.matchAll(/-- Source: (.+)/g)].map(match=>match[1]),files);await db.exec(bundle);
 assert.equal((await db.query<{present:boolean}>("select to_regprocedure('public.read_privacy_impact(uuid,uuid,integer)') is not null present")).rows[0].present,true);
 assert.equal((await db.query<{name:string}>("select to_regclass('public.invitations')::text as name")).rows[0].name,'invitations');await assert.rejects(()=>db.exec(bundle),/LeadPilot tables already exist/);await db.exec('rollback');assert.equal((await db.query<{count:number}>('select count(*)::int as count from public.agencies')).rows[0].count,0);
 }finally{await db.close();}
});
