import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
export const migrationDir=new URL('../../supabase/migrations/',import.meta.url);
export async function localDatabase(options:{through?:number;legacyAuthEmailText?:boolean}={}){
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
  create table auth.users(id uuid primary key,email_confirmed_at timestamptz,email ${options.legacyAuthEmailText?'text':'varchar(255)'});
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
  grant usage on schema auth to authenticated;`);
  const files=(await readdir(migrationDir)).filter(f=>f.endsWith('.sql')).sort();
  for(const file of files.slice(0,options.through??files.length))await db.exec(await readFile(new URL(file,migrationDir),'utf8'));
  return db;
 }catch(error){await db.close();throw error;}
}
export async function identity(db:PGlite,id:string,fresh=false,age=0){
 await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({aal:fresh?'aal2':'aal1',amr:fresh?[{method:'totp',timestamp:Math.floor(Date.now()/1000)-age}]:[]})]);
 await db.exec('set role authenticated');
}
export async function rpc(db:PGlite,name:string,args:unknown[]=[]){
 if(!/^[a-z_]+$/.test(name))throw Error('Invalid local RPC name');
 return (await db.query<{r:any}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
}
export async function seedPrivacyFixture(db:PGlite){
 const owner=crypto.randomUUID(),admin=crypto.randomUUID(),agent=crypto.randomUUID(),other=crypto.randomUUID();
 for(const id of [owner,admin,agent,other])await db.query('insert into auth.users values($1,now(),$2)',[id,id+'@example.test']);
 await identity(db,owner);const agency=(await rpc(db,'create_agency',[{name:'Local hardening fixture'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await identity(db,other);const foreign=(await rpc(db,'create_agency',[{name:'Other fixture'},crypto.randomUUID(),crypto.randomUUID()])).agency;
 await db.exec('reset role');
 const members:Record<string,string>={};
 for(const [tenant,user,role] of [[agency.id,admin,'ADMIN'],[agency.id,agent,'AGENT'],[foreign.id,owner,'AGENT']])members[user+tenant]=(await db.query<{id:string}>('insert into public.memberships(tenant_id,user_id,role) values($1,$2,$3) returning id',[tenant,user,role])).rows[0].id;
 const lead=(await db.query<any>("insert into public.leads(tenant_id,assignee_id,full_name,email,source,created_by) values($1,$2,'Synthetic lead','synthetic@example.test','MANUAL',$3) returning *",[agency.id,members[agent+agency.id],owner])).rows[0];
 const foreignLead=(await db.query<any>("insert into public.leads(tenant_id,full_name,email,source,created_by) values($1,'Foreign lead','foreign@example.test','MANUAL',$2) returning *",[foreign.id,other])).rows[0];
 await db.query("insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at) values($1,$2,'INBOUND','MANUAL','Synthetic private message',now())",[agency.id,lead.id]);
 await identity(db,owner,true);
 return {owner,admin,agent,other,agency,foreign,lead,foreignLead,members};
}
