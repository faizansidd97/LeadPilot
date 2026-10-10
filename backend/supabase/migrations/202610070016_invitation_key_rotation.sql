begin;
-- Keep raw HMAC keys and bearer tokens outside PostgreSQL. Persist only issuance provenance.
create table private.invitation_signing_policy(singleton boolean primary key default true check(singleton),key_id text not null default 'legacy' check(key_id ~ '^[a-z][a-z0-9_-]{0,39}$' and key_id not in ('constructor','prototype')),version integer not null default 1 check(version>0),updated_at timestamptz not null default now());
insert into private.invitation_signing_policy(singleton) values(true);
create table private.invitation_issuances(actor_id uuid not null,operation text not null,request_key uuid not null,tenant_id uuid not null,invitation_id uuid,key_id text not null check(key_id ~ '^[a-z][a-z0-9_-]{0,39}$' and key_id not in ('constructor','prototype')),primary key(actor_id,operation,request_key));
insert into private.invitation_issuances select actor_id,operation,request_key,tenant_id,(response->>'id')::uuid,'legacy' from private.api_requests where operation='invite:'||tenant_id::text or operation like 'invite-action:'||tenant_id::text||':%:resend';
update private.outbox_events set payload=payload||jsonb_build_object('signing_key_id','legacy') where event_type='INVITATION_MAIL';
create table private.invitation_signing_operations(request_key uuid primary key,payload_hash text not null,response jsonb not null,reference text not null check(char_length(trim(reference)) between 5 and 200),request_id uuid not null,created_at timestamptz not null default now());
revoke all on private.invitation_signing_policy,private.invitation_issuances,private.invitation_signing_operations from public,anon,authenticated,service_role;

create function public.invitation_signing_key(p_tenant uuid,p_action text,p_invite uuid,p_key uuid,p_payload jsonb) returns text language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);i public.invitations;r private.invitation_issuances;op text;chosen text;
begin
 perform private.verified_actor();
 if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if p_action is null or p_action not in ('create','resend') or p_key is null or (p_action='create' and p_invite is not null) or (p_action='resend' and p_invite is null) then raise exception 'VALIDATION_FAILED';end if;
 op:=case when p_action='create' then 'invite:'||p_tenant::text else 'invite-action:'||p_tenant::text||':'||p_invite::text||':resend' end;
 select * into r from private.invitation_issuances where actor_id=m.user_id and operation=op and request_key=p_key and tenant_id=p_tenant;
 if p_action='resend' or r.invitation_id is not null then
  select * into i from public.invitations where tenant_id=p_tenant and id=coalesce(p_invite,r.invitation_id);
  if not found then raise exception 'NOT_FOUND';end if;
  if i.state<>'PENDING' or (r.invitation_id is not null and i.expires_at<=now()) then raise exception 'INVITATION_UNAVAILABLE';end if;
  if i.role='ADMIN' then if m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;perform private.require_recent_mfa();end if;
 end if;
 if p_action='create' and p_payload->>'role'='ADMIN' then if m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;perform private.require_recent_mfa();end if;
 select key_id into chosen from private.invitation_signing_policy where singleton;
 return coalesce(r.key_id,chosen);
end;$$;
revoke all on function public.invitation_signing_key(uuid,text,uuid,uuid,jsonb) from public,anon,service_role;
grant execute on function public.invitation_signing_key(uuid,text,uuid,uuid,jsonb) to authenticated;

-- The existing business mutations remain the authority for payload, seats, versions,
-- current roles, MFA, replay/hash checks and atomic audit. Hide their old entry points.
alter function public.create_team_invitation(uuid,jsonb,text,uuid,uuid) set schema private;
alter function private.create_team_invitation(uuid,jsonb,text,uuid,uuid) rename to create_team_invitation_core;
alter function public.change_team_invitation(uuid,uuid,text,jsonb,text,uuid,uuid) set schema private;
alter function private.change_team_invitation(uuid,uuid,text,jsonb,text,uuid,uuid) rename to change_team_invitation_core;
revoke all on function private.create_team_invitation_core(uuid,jsonb,text,uuid,uuid),private.change_team_invitation_core(uuid,uuid,text,jsonb,text,uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.enqueue_invitation_mail(p_tenant uuid,p_invite uuid,p_actor uuid,p_scope text,p_key uuid,p_hash text) returns void language sql security definer set search_path='' as $$
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload)
 select p_tenant,'INVITATION_MAIL',p_invite,'mail:'||p_actor::text||':'||p_scope||':'||p_invite::text||':'||p_key::text,jsonb_build_object('actor_id',p_actor,'token_operation',p_scope,'request_key',p_key,'token_hash',p_hash,'signing_key_id',s.key_id)
 from private.invitation_issuances s where s.tenant_id=p_tenant and s.actor_id=p_actor and s.request_key=p_key and s.operation=case when p_scope='create:' then 'invite:'||p_tenant::text else 'invite-action:'||p_tenant::text||':'||p_invite::text||':resend' end
 on conflict(tenant_id,dedupe_key) do nothing;
$$;

create function public.create_team_invitation(p_tenant uuid,p_payload jsonb,p_token_hash text,p_key uuid,p_request_id uuid,p_signing_key_id text default 'legacy') returns jsonb language plpgsql security definer set search_path='' as $$
declare chosen text;result jsonb;op text:='invite:'||p_tenant::text;
begin
 perform 1 from public.agencies where id=p_tenant for update;
 perform 1 from private.invitation_signing_policy where singleton for share;
 chosen:=public.invitation_signing_key(p_tenant,'create',null,p_key,p_payload);
 if p_signing_key_id is distinct from chosen then raise exception 'INVITATION_KEY_POLICY_CONFLICT';end if;
 insert into private.invitation_issuances values(auth.uid(),op,p_key,p_tenant,null,chosen) on conflict do nothing;
 result:=private.create_team_invitation_core(p_tenant,p_payload,p_token_hash,p_key,p_request_id);
 update private.invitation_issuances set invitation_id=(result->>'id')::uuid where actor_id=auth.uid() and operation=op and request_key=p_key;
 return result;
end;$$;
create function public.change_team_invitation(p_tenant uuid,p_invite uuid,p_action text,p_payload jsonb,p_token_hash text,p_key uuid,p_request_id uuid,p_signing_key_id text default 'legacy') returns jsonb language plpgsql security definer set search_path='' as $$
declare chosen text;op text:='invite-action:'||p_tenant::text||':'||p_invite::text||':resend';
begin
 if p_action='resend' then
  perform 1 from public.agencies where id=p_tenant for update;
  perform 1 from private.invitation_signing_policy where singleton for share;
  chosen:=public.invitation_signing_key(p_tenant,p_action,p_invite,p_key,p_payload);
  if p_signing_key_id is distinct from chosen then raise exception 'INVITATION_KEY_POLICY_CONFLICT';end if;
  insert into private.invitation_issuances values(auth.uid(),op,p_key,p_tenant,p_invite,chosen) on conflict do nothing;
 end if;
 return private.change_team_invitation_core(p_tenant,p_invite,p_action,p_payload,p_token_hash,p_key,p_request_id);
end;$$;
revoke all on function public.create_team_invitation(uuid,jsonb,text,uuid,uuid,text),public.change_team_invitation(uuid,uuid,text,jsonb,text,uuid,uuid,text) from public,anon,service_role;
grant execute on function public.create_team_invitation(uuid,jsonb,text,uuid,uuid,text),public.change_team_invitation(uuid,uuid,text,jsonb,text,uuid,uuid,text) to authenticated;

create function public.worker_invitation_signing_state() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p private.invitation_signing_policy;counts jsonb;
begin
 perform private.require_worker();select * into p from private.invitation_signing_policy where singleton;
 -- Include all historical receipts: this inventory never authorizes removing a key.
 select coalesce(jsonb_object_agg(key_id,n),'{}'::jsonb) into counts from(select key_id,count(*) n from private.invitation_issuances group by key_id) s;
 return jsonb_build_object('key_id',p.key_id,'version',p.version,'issuance_counts',counts,'key_retirement_approved',false);
end;$$;
create function public.worker_set_invitation_signing_key(p_target text,p_expected_version integer,p_reference text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.invitation_signing_policy;r private.invitation_signing_operations;result jsonb;h text:=encode(sha256(convert_to(jsonb_build_array(p_target,p_expected_version,p_reference)::text,'UTF8')),'hex');
begin
 perform private.require_worker();
 if p_target is null or p_target !~ '^[a-z][a-z0-9_-]{0,39}$' or p_target in ('constructor','prototype') or p_expected_version is null or p_expected_version<1 or p_reference is null or char_length(trim(p_reference)) not between 5 and 200 or p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select * into p from private.invitation_signing_policy where singleton for update;
 select * into r from private.invitation_signing_operations where request_key=p_key;
 if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('key_id',p.key_id,'version',p.version,'replayed',true);end if;
 if p.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 if p.key_id=p_target then raise exception 'STATE_CONFLICT';end if;
 update private.invitation_signing_policy set key_id=p_target,version=version+1,updated_at=now() where singleton returning * into p;
 result:=jsonb_build_object('key_id',p.key_id,'version',p.version,'replayed',false);
 -- Immutable private change journal is the platform audit and operation receipt.
 insert into private.invitation_signing_operations values(p_key,h,result,trim(p_reference),p_request_id,now());return result;
end;$$;
revoke all on function public.worker_invitation_signing_state(),public.worker_set_invitation_signing_key(text,integer,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.worker_invitation_signing_state(),public.worker_set_invitation_signing_key(text,integer,text,uuid,uuid) to service_role;
create or replace function public.worker_prepare_invitation_mail(p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.outbox_events;invite public.invitations;member public.memberships;
begin
 perform private.require_worker();select * into job from private.outbox_events where id=p_job;
 if not found or job.event_type<>'INVITATION_MAIL' or job.state<>'RUNNING' or job.lease_token is distinct from p_lease or job.lease_until<=now() then return jsonb_build_object('available',false);end if;
 select * into invite from public.invitations where tenant_id=job.tenant_id and id=job.entity_id and state='PENDING' and expires_at>now() and token_hash=job.payload->>'token_hash';
 if not found then return jsonb_build_object('available',false);end if;
 select * into member from public.memberships where tenant_id=job.tenant_id and id=invite.inviter_member_id and user_id=(job.payload->>'actor_id')::uuid and active;
 if not found or member.role not in ('OWNER','ADMIN') or (member.role='ADMIN' and invite.role<>'AGENT') or not exists(select 1 from auth.users u where u.id=member.user_id and u.email_confirmed_at is not null) then return jsonb_build_object('available',false);end if;
 return jsonb_build_object('available',true,'to',invite.email,'tenant_id',job.tenant_id,'actor_id',member.user_id,'token_operation',job.payload->>'token_operation','request_key',job.payload->>'request_key','token_hash',invite.token_hash,'signing_key_id',coalesce(job.payload->>'signing_key_id','legacy'));
end; $$;

commit;
