begin;
create table private.website_integrations(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),name text not null check(char_length(trim(name)) between 2 and 120),
 default_assignee_id uuid,active boolean not null default true,version integer not null default 1,key_version integer not null default 1,secret_cipher text not null,secret_aad text not null,secret_hash text not null check(secret_hash ~ '^[a-f0-9]{64}$'),
 created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),foreign key(tenant_id,default_assignee_id) references public.memberships(tenant_id,id),unique(tenant_id,id));
create table private.intake_events(integration_id uuid not null,tenant_id uuid not null,external_event_id text not null,body_hash text not null check(body_hash ~ '^[a-f0-9]{64}$'),lead_id uuid not null,created_at timestamptz not null default now(),
 primary key(integration_id,external_event_id),foreign key(tenant_id,integration_id) references private.website_integrations(tenant_id,id),foreign key(tenant_id,lead_id) references public.leads(tenant_id,id));
create table private.intake_limits(integration_id uuid not null references private.website_integrations(id),window_at timestamptz not null,count integer not null,primary key(integration_id,window_at));
revoke all on private.website_integrations,private.intake_events,private.intake_limits from public,anon,authenticated;
create function private.integration_view(i private.website_integrations) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',i.id,'name',i.name,'default_assignee_id',i.default_assignee_id,'active',i.active,'version',i.version,'key_version',i.key_version,'created_at',i.created_at);
$$;
create function public.list_website_integrations(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);rows jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select coalesce(jsonb_agg(private.integration_view(i) order by i.created_at desc,i.id),'[]') into rows from private.website_integrations i where tenant_id=p_tenant;return rows;
end;$$;
create function public.manage_website_integration(p_tenant uuid,p_id uuid,p_action text,p_payload jsonb,p_cipher text,p_aad text,p_secret_hash text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);i private.website_integrations;r private.api_requests;op text:='integration:'||p_tenant||':'||p_action||':'||coalesce(p_id::text,'new');h text:=encode(sha256(convert_to(jsonb_build_object('payload',p_payload,'hash',p_secret_hash)::text,'UTF8')),'hex');result jsonb;target uuid;
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
 if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if p_action='create' then
  insert into private.website_integrations(tenant_id,name,default_assignee_id,secret_cipher,secret_aad,secret_hash,created_by) values(p_tenant,trim(p_payload->>'name'),target,p_cipher,p_aad,p_secret_hash,m.user_id) returning * into i;
 else
  if p_payload->>'expected_version'<>i.version::text then raise exception 'VERSION_CONFLICT';end if;if not i.active then raise exception 'STATE_CONFLICT';end if;
  update private.website_integrations set active=p_action<>'revoke',version=version+1,key_version=key_version+1,
  secret_cipher=case when p_action='rotate' then p_cipher else secret_cipher end,secret_aad=case when p_action='rotate' then p_aad else secret_aad end,secret_hash=case when p_action='rotate' then p_secret_hash else secret_hash end,
  created_by=case when p_action='rotate' then m.user_id else created_by end where tenant_id=p_tenant and id=i.id returning * into i;
 end if;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,reason,details) values(p_tenant,m.user_id,'INTEGRATION_'||upper(p_action),p_request_id,p_payload->>'reason',jsonb_build_object('integration_id',i.id,'key_version',i.key_version));
 result:=private.integration_view(i);insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create function public.worker_intake_credential(p_integration uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.website_integrations;begin
 perform private.require_worker();select * into i from private.website_integrations where id=p_integration and active;
 if not found or not exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=i.tenant_id and m.user_id=i.created_by and m.active and m.role in ('OWNER','ADMIN') and u.email_confirmed_at is not null) then return null;end if;
 return jsonb_build_object('secret_cipher',i.secret_cipher,'secret_aad',i.secret_aad,'key_version',i.key_version,'secret_hash',i.secret_hash);
end;$$;
create function public.worker_intake_limit(p_integration uuid,p_key_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare used integer;stamp timestamptz:=date_trunc('minute',now());begin
 perform private.require_worker();if not exists(select 1 from private.website_integrations where id=p_integration and active and key_version=p_key_version) then raise exception 'INTAKE_UNAVAILABLE';end if;
 insert into private.intake_limits values(p_integration,stamp,1) on conflict(integration_id,window_at) do update set count=least(intake_limits.count+1,61) returning count into used;
 delete from private.intake_limits where (integration_id,window_at) in (select integration_id,window_at from private.intake_limits where window_at<now()-interval '2 hours' order by window_at limit 100);
 return jsonb_build_object('allowed',used<=60,'retry_after',greatest(1,ceil(extract(epoch from stamp+interval '1 minute'-now()))::integer));
end;$$;
create function public.worker_ingest_lead(p_integration uuid,p_key_version integer,p_event text,p_body_hash text,p_payload jsonb,p_occurred timestamptz,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare i private.website_integrations;e private.intake_events;l public.leads;
begin
 perform private.require_worker();
 if p_request_id is null or p_event is null or p_event !~ '^[A-Za-z0-9_.:-]{1,120}$' or p_body_hash is null or p_body_hash !~ '^[a-f0-9]{64}$' or p_payload ? 'assignee_id' then raise exception 'VALIDATION_FAILED';end if;
 perform private.validate_lead(p_payload);
 select * into i from private.website_integrations where id=p_integration;if not found then raise exception 'INTAKE_UNAVAILABLE';end if;
 -- Tenant lock also coordinates revoke/rotation and offboarding with publication.
 perform 1 from public.agencies where id=i.tenant_id for update;
 select * into i from private.website_integrations where id=p_integration and active and key_version=p_key_version for update;
 if not found or not exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=i.tenant_id and m.user_id=i.created_by and m.active and m.role in ('OWNER','ADMIN') and u.email_confirmed_at is not null) then raise exception 'INTAKE_UNAVAILABLE';end if;
 select * into e from private.intake_events where integration_id=i.id and external_event_id=p_event;
 if found then if e.body_hash<>p_body_hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('id',e.lead_id,'replayed',true);end if;
 l:=private.insert_capture(i.tenant_id,p_payload,i.default_assignee_id,'WEBSITE',i.created_by,p_request_id,p_occurred);
 insert into private.intake_events values(i.id,i.tenant_id,p_event,p_body_hash,l.id,now());
 return jsonb_build_object('id',l.id,'status',l.status,'version',l.version,'duplicate_review',l.duplicate_review,'replayed',false);
end;$$;
revoke all on function private.integration_view(private.website_integrations) from public,anon,authenticated;
revoke all on function public.list_website_integrations(uuid),public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid) from public,anon;
grant execute on function public.list_website_integrations(uuid),public.manage_website_integration(uuid,uuid,text,jsonb,text,text,text,uuid,uuid) to authenticated;
revoke all on function public.worker_intake_credential(uuid),public.worker_intake_limit(uuid,integer),public.worker_ingest_lead(uuid,integer,text,text,jsonb,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.worker_intake_credential(uuid),public.worker_intake_limit(uuid,integer),public.worker_ingest_lead(uuid,integer,text,text,jsonb,timestamptz,uuid) to service_role;
commit;
