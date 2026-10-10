begin;
-- Storage key version is separate from the website signing key version.
alter table private.website_integrations add column encryption_key_id text not null default 'legacy' check(encryption_key_id ~ '^[a-z][a-z0-9_-]{0,39}$' and encryption_key_id not in ('constructor','prototype')),add column encryption_revision integer not null default 1 check(encryption_revision>0);
create table private.intake_encryption_policy(singleton boolean primary key default true check(singleton),key_id text not null default 'legacy' check(key_id ~ '^[a-z][a-z0-9_-]{0,39}$' and key_id not in ('constructor','prototype')),version integer not null default 1 check(version>0),updated_at timestamptz not null default now());
insert into private.intake_encryption_policy(singleton) values(true);
create table private.intake_encryption_operations(request_key uuid primary key,operation text not null check(operation in ('ACTIVATE','REWRAP')),payload_hash text not null check(payload_hash ~ '^[a-f0-9]{64}$'),response jsonb not null,reference text not null check(char_length(trim(reference)) between 5 and 200),request_id uuid not null,created_at timestamptz not null default now());
revoke all on private.intake_encryption_policy,private.intake_encryption_operations from public,anon,authenticated,service_role;
create function public.integration_encryption_key(p_tenant uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);k text;
begin if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;select key_id into k from private.intake_encryption_policy where singleton;return k;end;$$;
revoke all on function public.integration_encryption_key(uuid) from public,anon;grant execute on function public.integration_encryption_key(uuid) to authenticated;
drop function public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid);
create function public.manage_website_integration(p_tenant uuid,p_id uuid,p_action text,p_payload jsonb,p_cipher text,p_aad text,p_secret_hash text,p_key uuid,p_request_id uuid,p_encryption_key_id text default 'legacy') returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);i private.website_integrations;r private.api_requests;op text:='integration:'||p_tenant||':'||p_action||':'||coalesce(p_id::text,'new');h text:=encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'hash',p_secret_hash)::text,'UTF8')),'hex');result jsonb;target uuid;current_key text;
begin
 if p_key is null or p_request_id is null or p_action not in ('create','rotate','revoke') or p_action is null or jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'VALIDATION_FAILED';end if;
 if p_action='create' then
  if p_id is not null or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('name','default_assignee_id')) or jsonb_typeof(p_payload->'name') is distinct from 'string' or char_length(trim(p_payload->>'name')) not between 2 and 120 then raise exception 'VALIDATION_FAILED';end if;
  begin target:=(p_payload->>'default_assignee_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;
  if target is not null and not exists(select 1 from public.memberships x join auth.users u on u.id=x.user_id where x.tenant_id=p_tenant and x.id=target and x.active and u.email_confirmed_at is not null) then raise exception 'VALIDATION_FAILED';end if;
  if (select count(*) from private.website_integrations where tenant_id=p_tenant)>=20 and not exists(select 1 from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key) then raise exception 'INTEGRATION_LIMIT';end if;
 else
  if p_id is null or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','reason')) or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;
  select * into i from private.website_integrations where tenant_id=p_tenant and id=p_id for update;if not found then raise exception 'NOT_FOUND';end if;
 end if;
 if p_action<>'revoke' and (p_cipher is null or char_length(p_cipher) not between 80 and 2000 or p_cipher !~ '^[a-f0-9]+$' or p_aad is null or char_length(p_aad)>500 or p_secret_hash is null or p_secret_hash !~ '^[a-f0-9]{64}$') then raise exception 'VALIDATION_FAILED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;
 if found then
  if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  select * into i from private.website_integrations where tenant_id=p_tenant and id=(r.response->>'id')::uuid;
  if not found or p_action<>'revoke' and (not i.active or i.secret_hash<>p_secret_hash) then raise exception 'STATE_CONFLICT';end if;return private.integration_view(i);
 end if;
 select key_id into current_key from private.intake_encryption_policy where singleton for share;
 if p_action<>'revoke' and (p_encryption_key_id is null or p_encryption_key_id<>current_key) then raise exception 'INTAKE_KEY_POLICY_CONFLICT';end if;
 if p_action='create' then
  insert into private.website_integrations(tenant_id,name,default_assignee_id,secret_cipher,secret_aad,secret_hash,created_by,encryption_key_id) values(p_tenant,trim(p_payload->>'name'),target,p_cipher,p_aad,p_secret_hash,m.user_id,p_encryption_key_id) returning * into i;
 else
  if p_payload->>'expected_version'<>i.version::text then raise exception 'VERSION_CONFLICT';end if;if not i.active then raise exception 'STATE_CONFLICT';end if;
  update private.website_integrations set active=p_action<>'revoke',version=version+1,key_version=key_version+1,
  secret_cipher=case when p_action='rotate' then p_cipher else secret_cipher end,secret_aad=case when p_action='rotate' then p_aad else secret_aad end,secret_hash=case when p_action='rotate' then p_secret_hash else secret_hash end,
  encryption_key_id=case when p_action='rotate' then p_encryption_key_id else encryption_key_id end,encryption_revision=encryption_revision+1,
  created_by=case when p_action='rotate' then m.user_id else created_by end where tenant_id=p_tenant and id=i.id returning * into i;
 end if;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,reason,details) values(p_tenant,m.user_id,'INTEGRATION_'||upper(p_action),p_request_id,p_payload->>'reason',jsonb_build_object('integration_id',i.id,'key_version',i.key_version));
 result:=private.integration_view(i);insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create or replace function public.worker_intake_credential(p_integration uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.website_integrations;begin
 perform private.require_worker();select * into i from private.website_integrations where id=p_integration and active;
 if not found or not exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=i.tenant_id and m.user_id=i.created_by and m.active and m.role in ('OWNER','ADMIN') and u.email_confirmed_at is not null) then return null;end if;
 return jsonb_build_object('secret_cipher',i.secret_cipher,'secret_aad',i.secret_aad,'key_version',i.key_version,'secret_hash',i.secret_hash,'encryption_key_id',i.encryption_key_id);
end;$$;

revoke all on function public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid,text) from public,anon,service_role;
grant execute on function public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid,text) to authenticated;

create function public.worker_intake_encryption_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare counts jsonb;policy private.intake_encryption_policy;
begin
 perform private.require_worker();select * into policy from private.intake_encryption_policy where singleton;
 select coalesce(jsonb_object_agg(key_id,n),'{}'::jsonb) into counts from(select encryption_key_id key_id,count(*) n from private.website_integrations group by encryption_key_id) s;
 return jsonb_build_object('key_id',policy.key_id,'version',policy.version,'counts',counts);
end;$$;
create function public.worker_list_intake_encryption(p_after uuid default null,p_limit integer default 25) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
 perform private.require_worker();if p_limit is null or p_limit not between 1 and 25 then raise exception 'VALIDATION_FAILED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'encryption_revision',i.encryption_revision,'encryption_key_id',i.encryption_key_id,'secret_cipher',i.secret_cipher,'secret_aad',i.secret_aad,'secret_hash',i.secret_hash) order by i.id),'[]'::jsonb) into rows from(select * from private.website_integrations where p_after is null or id>p_after order by id limit p_limit) i;
 return rows;
end;$$;
create function public.worker_set_intake_encryption_key(p_target text,p_expected_version integer,p_reference text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare policy private.intake_encryption_policy;prior private.intake_encryption_operations;h text:=encode(sha256(convert_to(jsonb_build_object('target',p_target,'version',p_expected_version,'reference',p_reference)::text,'UTF8')),'hex');result jsonb;
begin
 perform private.require_worker();
 if p_target is null or p_target !~ '^[a-z][a-z0-9_-]{0,39}$' or p_target in ('constructor','prototype') or p_expected_version is null or p_expected_version<1 or p_key is null or p_request_id is null or p_reference is null or char_length(trim(p_reference)) not between 5 and 200 then raise exception 'VALIDATION_FAILED';end if;
 select * into policy from private.intake_encryption_policy where singleton for update;
 select * into prior from private.intake_encryption_operations where request_key=p_key;
 if found then if prior.operation<>'ACTIVATE' or prior.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('key_id',policy.key_id,'version',policy.version,'replayed',true);end if;
 if policy.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 if policy.key_id=p_target then raise exception 'STATE_CONFLICT';end if;
 update private.intake_encryption_policy set key_id=p_target,version=version+1,updated_at=now() where singleton returning * into policy;
 result:=jsonb_build_object('key_id',policy.key_id,'version',policy.version,'replayed',false);
 insert into private.intake_encryption_operations values(p_key,'ACTIVATE',h,result,trim(p_reference),p_request_id,now());return result;
end;$$;
create function private.intake_encryption_revision(p_payload jsonb,p_name text) returns integer language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
 if jsonb_typeof(p_payload->p_name) is distinct from 'number' then raise exception 'VALIDATION_FAILED';end if;
 n:=(p_payload->>p_name)::numeric;if n<1 or n>2147483647 or n<>trunc(n) then raise exception 'VALIDATION_FAILED';end if;return n::integer;
end;$$;
revoke all on function private.intake_encryption_revision(jsonb,text) from public,anon,authenticated,service_role;
create function public.worker_rewrap_intake_encryption(p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.website_integrations;policy private.intake_encryption_policy;prior private.intake_encryption_operations;target text:=p_payload->>'target_key_id';source_key text:=p_payload->>'old_key_id';new_cipher text:=p_payload->>'cipher';old_hash text:=p_payload->>'old_cipher_hash';ref text:=p_payload->>'reference';v_id uuid;expected integer;expected_policy integer;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');result jsonb;
begin
 perform private.require_worker();perform private.team_payload(p_payload,array['integration_id','expected_encryption_revision','expected_policy_version','old_key_id','old_cipher_hash','target_key_id','cipher','reference']);
 expected:=private.intake_encryption_revision(p_payload,'expected_encryption_revision');expected_policy:=private.intake_encryption_revision(p_payload,'expected_policy_version');
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload->'reference') is distinct from 'string' or char_length(trim(ref)) not between 5 and 200 or target is null or target !~ '^[a-z][a-z0-9_-]{0,39}$' or source_key is null or source_key !~ '^[a-z][a-z0-9_-]{0,39}$' or target in ('constructor','prototype') or source_key in ('constructor','prototype') or target=source_key or new_cipher is null or new_cipher !~ '^[a-f0-9]{184}$' or old_hash is null or old_hash !~ '^[a-f0-9]{64}$' then raise exception 'VALIDATION_FAILED';end if;
 begin v_id:=(p_payload->>'integration_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;
 select * into i from private.website_integrations where website_integrations.id=v_id;if not found then raise exception 'NOT_FOUND';end if;
 -- Same agency lock as manager rotation/revocation, then shared global policy fence.
 perform 1 from public.agencies where agencies.id=i.tenant_id for update;
 select * into policy from private.intake_encryption_policy where singleton for share;
 if policy.key_id<>target or policy.version<>expected_policy then raise exception 'INTAKE_KEY_POLICY_CONFLICT';end if;
 select * into i from private.website_integrations where website_integrations.id=v_id for update;
 select * into prior from private.intake_encryption_operations where request_key=p_key;
 if found then if prior.operation<>'REWRAP' or prior.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('encryption_key_id',i.encryption_key_id,'encryption_revision',i.encryption_revision,'replayed',true);end if;
 if i.encryption_revision<>expected or i.encryption_key_id<>source_key or encode(sha256(convert_to(i.secret_cipher,'UTF8')),'hex')<>old_hash then raise exception 'VERSION_CONFLICT';end if;
 update private.website_integrations set secret_cipher=new_cipher,encryption_key_id=target,encryption_revision=encryption_revision+1 where website_integrations.id=v_id returning * into i;
 insert into public.activity_events(tenant_id,event_type,request_id,details) values(i.tenant_id,'INTAKE_ENCRYPTION_REWRAPPED',p_request_id,jsonb_build_object('integration_id',i.id,'from_key_id',source_key,'to_key_id',target,'encryption_revision',i.encryption_revision));
 result:=jsonb_build_object('encryption_key_id',i.encryption_key_id,'encryption_revision',i.encryption_revision,'replayed',false);
 insert into private.intake_encryption_operations values(p_key,'REWRAP',h,result,trim(ref),p_request_id,now());return result;
end;$$;
revoke all on function public.worker_intake_encryption_state(),public.worker_list_intake_encryption(uuid,integer),public.worker_set_intake_encryption_key(text,integer,text,uuid,uuid),public.worker_rewrap_intake_encryption(jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.worker_intake_encryption_state(),public.worker_list_intake_encryption(uuid,integer),public.worker_set_intake_encryption_key(text,integer,text,uuid,uuid),public.worker_rewrap_intake_encryption(jsonb,uuid,uuid) to service_role;
commit;
