begin;
-- Verified email is required even for direct RLS reads, independently of HTTP/RPC guards.
create or replace function private.can_read_lead(p_tenant uuid,p_assignee uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id
 where m.tenant_id=p_tenant and m.user_id=(select auth.uid()) and u.email_confirmed_at is not null
 and m.active and (m.role in ('OWNER','ADMIN') or m.id=p_assignee));
$$;
create or replace function private.has_membership(p_tenant uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id
 where m.tenant_id=p_tenant and m.user_id=(select auth.uid()) and m.active and u.email_confirmed_at is not null);
$$;
create policy verified_membership_read on public.memberships as restrictive for select to authenticated using(private.has_membership(tenant_id));
create policy verified_invitation_read on public.invitations as restrictive for select to authenticated using(private.has_membership(tenant_id));
create policy verified_notification_read on public.notifications as restrictive for select to authenticated using(private.has_membership(tenant_id));
create policy verified_activity_read on public.activity_events as restrictive for select to authenticated using(private.has_membership(tenant_id));
create function private.privacy_version(p_payload jsonb) returns integer language plpgsql immutable set search_path='' as $$
declare v numeric;
begin
 if jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED';end if;
 v:=(p_payload->>'expected_version')::numeric;
 if v<1 or v>2147483647 or v<>trunc(v) then raise exception 'VALIDATION_FAILED';end if;return v::integer;
end;$$;
revoke all on function private.privacy_version(jsonb) from public,anon,authenticated;
-- Intake/review records only. No approval, purge, anonymization or closure execution is granted.
create table public.privacy_cases(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),kind text not null check(kind in ('LEAD_ERASURE','AGENCY_CLOSURE')),lead_id uuid,
 state text not null default 'REQUESTED' check(state in ('REQUESTED','IN_REVIEW','ON_HOLD','WITHDRAWN')),reason text not null check(char_length(trim(reason)) between 5 and 500),
 version integer not null default 1 check(version>0),requested_by uuid not null references auth.users(id),reviewer_member_id uuid,verification_reference text check(char_length(verification_reference) between 5 and 200),hold_reason text check(char_length(hold_reason) between 5 and 500),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),foreign key(tenant_id,lead_id) references public.leads(tenant_id,id),foreign key(tenant_id,reviewer_member_id) references public.memberships(tenant_id,id),unique(tenant_id,id),
 check((kind='LEAD_ERASURE')=(lead_id is not null)),check((state='ON_HOLD')=(hold_reason is not null)));
create unique index one_open_privacy_case on public.privacy_cases(tenant_id,kind,coalesce(lead_id,'00000000-0000-0000-0000-000000000000'::uuid)) where state<>'WITHDRAWN';
create index privacy_case_history on public.privacy_cases(tenant_id,created_at desc,id desc);
alter table public.privacy_cases enable row level security;
create policy privacy_case_read on public.privacy_cases for select to authenticated using(exists(select 1 from public.memberships m where m.tenant_id=privacy_cases.tenant_id and m.user_id=auth.uid() and m.active and m.role in ('OWNER','ADMIN')));
create policy verified_privacy_read on public.privacy_cases as restrictive for select to authenticated using(private.has_membership(tenant_id));
revoke all on public.privacy_cases from public,anon,authenticated;grant select on public.privacy_cases to authenticated;
-- Immutable manager-only review notes; operational audit carries IDs/state only.
create table public.privacy_case_actions(
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,case_id uuid not null,
 actor_id uuid not null references auth.users(id),action text not null check(action in ('REVIEW','HOLD','RELEASE_HOLD','WITHDRAW')),
 case_version integer not null check(case_version>1),reason text not null check(char_length(trim(reason)) between 5 and 500),created_at timestamptz not null default now(),
 foreign key(tenant_id,case_id) references public.privacy_cases(tenant_id,id),unique(tenant_id,case_id,case_version));
create index privacy_action_history on public.privacy_case_actions(tenant_id,case_id,created_at desc,id desc);
alter table public.privacy_case_actions enable row level security;
create policy privacy_action_read on public.privacy_case_actions for select to authenticated using(exists(select 1 from public.privacy_cases c where c.tenant_id=privacy_case_actions.tenant_id and c.id=privacy_case_actions.case_id));
revoke all on public.privacy_case_actions from public,anon,authenticated;grant select on public.privacy_case_actions to authenticated;
create function public.list_privacy_cases(p_tenant uuid,p_cursor_time timestamptz default null,p_cursor_id uuid default null)
returns setof public.privacy_cases language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);
begin
 if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if (p_cursor_time is null)<>(p_cursor_id is null) then raise exception 'VALIDATION_FAILED';end if;
 return query select c.* from public.privacy_cases c where c.tenant_id=p_tenant and (p_cursor_time is null or (c.created_at,c.id)<(p_cursor_time,p_cursor_id)) order by c.created_at desc,c.id desc limit 26;
end;$$;
create function public.request_privacy_case(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);c public.privacy_cases;prior private.api_requests;l public.leads;target uuid;v_kind text:=p_payload->>'kind';v_operation text:='privacy_request:'||p_tenant;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;perform private.require_recent_mfa();
 perform private.team_payload(p_payload,array['kind','lead_id','expected_version','reason']);perform private.privacy_version(p_payload);
 if p_key is null or p_request_id is null or v_kind not in ('LEAD_ERASURE','AGENCY_CLOSURE') or v_kind is null or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;
 begin target:=(p_payload->>'lead_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;
 if (v_kind='LEAD_ERASURE')<>(target is not null) then raise exception 'VALIDATION_FAILED';end if;
 if target is not null then select * into l from public.leads where tenant_id=p_tenant and id=target for share;if not found then raise exception 'NOT_FOUND';end if;end if;
 select * into prior from private.api_requests where actor_id=m.user_id and operation=v_operation and request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;select * into c from public.privacy_cases where tenant_id=p_tenant and id=(prior.response->>'id')::uuid;return to_jsonb(c);end if;
 if target is not null and l.version<>(p_payload->>'expected_version')::integer or target is null and not exists(select 1 from public.agencies where id=p_tenant and version=(p_payload->>'expected_version')::integer) then raise exception 'VERSION_CONFLICT';end if;
 if exists(select 1 from public.privacy_cases where tenant_id=p_tenant and kind=v_kind and lead_id is not distinct from target and state<>'WITHDRAWN') then raise exception 'PRIVACY_CASE_EXISTS';end if;
 insert into public.privacy_cases(tenant_id,kind,lead_id,reason,requested_by) values(p_tenant,v_kind,target,trim(p_payload->>'reason'),m.user_id) returning * into c;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,target,m.user_id,'PRIVACY_REQUESTED',p_request_id,jsonb_build_object('case_id',c.id,'kind',c.kind,'case_version',c.version));
 insert into private.api_requests values(m.user_id,v_operation,p_key,hash,p_tenant,jsonb_build_object('id',c.id),now());return to_jsonb(c);
end;$$;
create function public.triage_privacy_case(p_tenant uuid,p_case uuid,p_payload jsonb,p_key uuid,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);c public.privacy_cases;prior private.api_requests;action text:=p_payload->>'action';v_operation text:='privacy_triage:'||p_tenant||':'||p_case;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');ref text:=nullif(trim(p_payload->>'verification_reference'),'');
begin
 if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;perform private.require_recent_mfa();
 perform private.team_payload(p_payload,array['action','expected_version','reason','verification_reference']);perform private.privacy_version(p_payload);
 if p_key is null or p_request_id is null or action not in ('REVIEW','HOLD','RELEASE_HOLD','WITHDRAW') or action is null or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 or (p_payload ? 'verification_reference' and jsonb_typeof(p_payload->'verification_reference') is distinct from 'string') then raise exception 'VALIDATION_FAILED';end if;
 if action='REVIEW' and (ref is null or char_length(ref) not between 5 and 200) or ref is not null and char_length(ref) not between 5 and 200 then raise exception 'VALIDATION_FAILED';end if;
 select * into c from public.privacy_cases where tenant_id=p_tenant and id=p_case for update;if not found then raise exception 'NOT_FOUND';end if;
 if action='WITHDRAW' and m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;
 select * into prior from private.api_requests where actor_id=m.user_id and operation=v_operation and request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return to_jsonb(c);end if;
 if c.version<>(p_payload->>'expected_version')::integer then raise exception 'VERSION_CONFLICT';end if;
 if c.state='WITHDRAWN' or action='REVIEW' and c.state<>'REQUESTED' or action='HOLD' and c.state='ON_HOLD' or action='RELEASE_HOLD' and c.state<>'ON_HOLD' or action='WITHDRAW' and c.state='ON_HOLD' then raise exception 'STATE_CONFLICT';end if;
 update public.privacy_cases set state=case action when 'REVIEW' then 'IN_REVIEW' when 'HOLD' then 'ON_HOLD' when 'RELEASE_HOLD' then case when verification_reference is null then 'REQUESTED' else 'IN_REVIEW' end else 'WITHDRAWN' end,
 verification_reference=case when action='REVIEW' then ref else verification_reference end,hold_reason=case when action='HOLD' then trim(p_payload->>'reason') else null end,reviewer_member_id=m.id,version=version+1,updated_at=now() where tenant_id=p_tenant and id=p_case returning * into c;
 insert into public.privacy_case_actions(tenant_id,case_id,actor_id,action,case_version,reason) values(p_tenant,c.id,m.user_id,action,c.version,trim(p_payload->>'reason'));
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,c.lead_id,m.user_id,'PRIVACY_'||action,p_request_id,jsonb_build_object('case_id',c.id,'kind',c.kind,'case_version',c.version,'state',c.state));
 insert into private.api_requests values(m.user_id,v_operation,p_key,hash,p_tenant,jsonb_build_object('id',c.id),now());return to_jsonb(c);
end;$$;
revoke all on function public.list_privacy_cases(uuid,timestamptz,uuid),public.request_privacy_case(uuid,jsonb,uuid,uuid),public.triage_privacy_case(uuid,uuid,jsonb,uuid,uuid) from public,anon;
grant execute on function public.list_privacy_cases(uuid,timestamptz,uuid),public.request_privacy_case(uuid,jsonb,uuid,uuid),public.triage_privacy_case(uuid,uuid,jsonb,uuid,uuid) to authenticated;

create function public.worker_health_snapshot() returns jsonb language plpgsql security definer set search_path='' as $$
declare due_lag integer;outbox_lag integer;ai_lag integer;outbox_pending bigint;outbox_failed bigint;ai_pending bigint;ai_failed bigint;reconcile bigint;reserved bigint;v_tokens bigint;privacy_pending bigint;
begin
 perform private.require_worker();
 select coalesce(greatest(0,extract(epoch from now()-min(d.due_at)))::integer,0) into due_lag from private.due_candidates d where not exists(select 1 from public.notifications n where n.tenant_id=d.tenant_id and n.recipient_id=d.recipient_id and n.dedupe_key=d.notice_key);
 select count(*),coalesce(greatest(0,extract(epoch from now()-min(created_at)))::integer,0) into outbox_pending,outbox_lag from private.outbox_events where state in ('PENDING','RUNNING');select count(*) into outbox_failed from private.outbox_events where state='FAILED';
 select count(*),coalesce(greatest(0,extract(epoch from now()-min(requested_at)))::integer,0) into ai_pending,ai_lag from public.ai_jobs where state in ('QUEUED','RUNNING');
 select count(*) filter(where state='FAILED'),count(*) filter(where usage_state='RECONCILE'),count(*) filter(where usage_state='RESERVED'),coalesce(sum(observed_tokens) filter(where month_at=date_trunc('month',now() at time zone 'UTC')::date),0) into ai_failed,reconcile,reserved,v_tokens from public.ai_jobs;
 select count(*) into privacy_pending from public.privacy_cases where state<>'WITHDRAWN';
 return jsonb_build_object('database','REACHABLE','captured_at',now(),'due_lag_seconds',due_lag,'outbox_lag_seconds',outbox_lag,'ai_lag_seconds',ai_lag,'outbox_pending',outbox_pending,'outbox_failed',outbox_failed,'ai_pending',ai_pending,'ai_failed',ai_failed,'reserved_operations',reserved,'reconcile_operations',reconcile,'observed_tokens_month',v_tokens,'cost_amount',null,'privacy_pending',privacy_pending,'privacy_execution_available',false,'alert',due_lag>900 or outbox_lag>900 or ai_lag>900 or outbox_failed>0 or ai_failed>0 or reconcile>0);
end;$$;
revoke all on function public.worker_health_snapshot() from public,anon,authenticated;grant execute on function public.worker_health_snapshot() to service_role;
commit;
