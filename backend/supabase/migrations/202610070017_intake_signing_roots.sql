begin;
-- Derivation roots govern future signing-secret issuance, not stored AES envelopes.
create table private.intake_signing_policy(singleton boolean primary key default true check(singleton),key_id text not null default 'legacy' check(key_id ~ '^[a-z][a-z0-9_-]{0,39}$' and key_id not in ('constructor','prototype')),version integer not null default 1 check(version>0),updated_at timestamptz not null default now());
insert into private.intake_signing_policy(singleton) values(true);
create table private.intake_signing_issuances(actor_id uuid not null,operation text not null,request_key uuid not null,tenant_id uuid not null,integration_id uuid,key_id text not null check(key_id ~ '^[a-z][a-z0-9_-]{0,39}$' and key_id not in ('constructor','prototype')),primary key(actor_id,operation,request_key));
insert into private.intake_signing_issuances select actor_id,operation,request_key,tenant_id,(response->>'id')::uuid,'legacy' from private.api_requests where operation='integration:'||tenant_id::text||':create:new' or operation like 'integration:'||tenant_id::text||':rotate:%';
create table private.intake_signing_operations(request_key uuid primary key,payload_hash text not null,response jsonb not null,reference text not null check(char_length(trim(reference)) between 5 and 200),request_id uuid not null,created_at timestamptz not null default now());
revoke all on private.intake_signing_policy,private.intake_signing_issuances,private.intake_signing_operations from public,anon,authenticated,service_role;

create function public.integration_signing_root(p_tenant uuid,p_action text,p_id uuid,p_key uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);i private.website_integrations;r private.intake_signing_issuances;op text;chosen text;
begin
 perform private.verified_actor();if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if p_action is null or p_action not in ('create','rotate') or p_key is null or (p_action='create' and p_id is not null) or (p_action='rotate' and p_id is null) then raise exception 'VALIDATION_FAILED';end if;
 op:='integration:'||p_tenant::text||':'||p_action||':'||coalesce(p_id::text,'new');
 select * into r from private.intake_signing_issuances where actor_id=m.user_id and operation=op and request_key=p_key and tenant_id=p_tenant;
 if p_action='rotate' or r.integration_id is not null then
  select * into i from private.website_integrations where tenant_id=p_tenant and id=coalesce(p_id,r.integration_id);
  if not found then raise exception 'NOT_FOUND';end if;if not i.active then raise exception 'STATE_CONFLICT';end if;
 end if;
 select key_id into chosen from private.intake_signing_policy where singleton;return coalesce(r.key_id,chosen);
end;$$;
revoke all on function public.integration_signing_root(uuid,text,uuid,uuid) from public,anon,service_role;
grant execute on function public.integration_signing_root(uuid,text,uuid,uuid) to authenticated;

-- Preserve the existing manager core's payload/hash/version/assignment/AES/replay/audit authority.
alter function public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid,text) set schema private;
alter function private.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid,text) rename to manage_website_integration_core;
revoke all on function private.manage_website_integration_core(uuid,uuid,text,jsonb,text,text,text,uuid,uuid,text) from public,anon,authenticated,service_role;
create function public.manage_website_integration(p_tenant uuid,p_id uuid,p_action text,p_payload jsonb,p_cipher text,p_aad text,p_secret_hash text,p_key uuid,p_request_id uuid,p_encryption_key_id text default 'legacy',p_signing_root_id text default 'legacy') returns jsonb language plpgsql security definer set search_path='' as $$
declare chosen text;result jsonb;op text:='integration:'||p_tenant::text||':'||p_action||':'||coalesce(p_id::text,'new');
begin
 if p_action in ('create','rotate') then
  perform 1 from public.agencies where id=p_tenant for update;
  perform 1 from private.intake_signing_policy where singleton for share;
  chosen:=public.integration_signing_root(p_tenant,p_action,p_id,p_key);
  if p_signing_root_id is distinct from chosen then raise exception 'INTAKE_SIGNING_POLICY_CONFLICT';end if;
  insert into private.intake_signing_issuances values(auth.uid(),op,p_key,p_tenant,p_id,chosen) on conflict do nothing;
 end if;
 result:=private.manage_website_integration_core(p_tenant,p_id,p_action,p_payload,p_cipher,p_aad,p_secret_hash,p_key,p_request_id,p_encryption_key_id);
 if p_action in ('create','rotate') then update private.intake_signing_issuances set integration_id=(result->>'id')::uuid where actor_id=auth.uid() and operation=op and request_key=p_key;end if;
 return result;
end;$$;
revoke all on function public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid,text,text) from public,anon,service_role;
grant execute on function public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid,text,text) to authenticated;

create function public.worker_intake_signing_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p private.intake_signing_policy;counts jsonb;aes text;
begin
 perform private.require_worker();select * into p from private.intake_signing_policy where singleton;
 select coalesce(jsonb_object_agg(key_id,n),'{}'::jsonb) into counts from(select key_id,count(*) n from private.intake_signing_issuances group by key_id) s;
 select key_id into aes from private.intake_encryption_policy where singleton;
 return jsonb_build_object('key_id',p.key_id,'version',p.version,'issuance_counts',counts,'encryption_key_id',aes,'key_retirement_approved',false);
end;$$;
create function public.worker_set_intake_signing_root(p_target text,p_expected_version integer,p_reference text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.intake_signing_policy;r private.intake_signing_operations;h text:=encode(sha256(convert_to(jsonb_build_array(p_target,p_expected_version,p_reference)::text,'UTF8')),'hex');result jsonb;
begin
 perform private.require_worker();
 if p_target is null or p_target !~ '^[a-z][a-z0-9_-]{0,39}$' or p_target in ('constructor','prototype') or p_expected_version is null or p_expected_version<1 or p_reference is null or char_length(trim(p_reference)) not between 5 and 200 or p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select * into p from private.intake_signing_policy where singleton for update;
 select * into r from private.intake_signing_operations where request_key=p_key;
 if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('key_id',p.key_id,'version',p.version,'replayed',true);end if;
 if p.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;if p.key_id=p_target then raise exception 'STATE_CONFLICT';end if;
 update private.intake_signing_policy set key_id=p_target,version=version+1,updated_at=now() where singleton returning * into p;
 result:=jsonb_build_object('key_id',p.key_id,'version',p.version,'replayed',false);
 -- Private immutable platform change journal and transport retry receipt commit together.
 insert into private.intake_signing_operations values(p_key,h,result,trim(p_reference),p_request_id,now());return result;
end;$$;
revoke all on function public.worker_intake_signing_state(),public.worker_set_intake_signing_root(text,integer,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.worker_intake_signing_state(),public.worker_set_intake_signing_root(text,integer,text,uuid,uuid) to service_role;
commit;
