-- Generated from versioned migrations. Regenerate with pnpm setup:supabase.
-- Apply once to a development project without existing LeadPilot tables.
-- All schema changes commit together; existing LeadPilot tables stop setup.
begin;
do $$
begin
 if exists (select 1 from pg_catalog.pg_tables where schemaname='public' and tablename in ('agencies','memberships','leads','messages','activity_events')) then
  raise exception 'LeadPilot tables already exist. Apply only the missing versioned migrations; do not rerun this setup bundle.';
 end if;
end;
$$;

-- Source: 202610060001_foundation.sql
-- Foundation only. Reviewed transactional RPCs must precede write access.

create type public.member_role as enum ('OWNER','ADMIN','AGENT');
create type public.lead_status as enum ('NEW','CONTACTED','QUALIFIED','FOLLOW_UP','WON','LOST');
create table public.agencies (
 id uuid primary key default gen_random_uuid(), name text not null check(char_length(name) between 2 and 120),
 timezone text not null default 'Asia/Dubai', locale text not null default 'en', ai_enabled boolean not null default false,
 version integer not null default 1 check(version>0), created_at timestamptz not null default now()
);
create table public.memberships (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.agencies(id),
 user_id uuid not null references auth.users(id), role public.member_role not null, active boolean not null default true,
 unique(tenant_id,user_id), unique(tenant_id,id)
);
create unique index one_active_owner on public.memberships(tenant_id) where role='OWNER' and active;
create table public.leads (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.agencies(id),
 assignee_id uuid, full_name text not null check(char_length(full_name) between 2 and 120), email text, phone text,
 status public.lead_status not null default 'NEW', source text not null check(source in ('MANUAL','WEBSITE','CSV')),
 do_not_contact boolean not null default false, archived_at timestamptz, version integer not null default 1 check(version>0),
 context_version integer not null default 1 check(context_version>0), created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id), unique(tenant_id,id),
 foreign key(tenant_id,assignee_id) references public.memberships(tenant_id,id),
 check(nullif(trim(email),'') is not null or nullif(trim(phone),'') is not null)
);
create index lead_inbox on public.leads(tenant_id,status,created_at desc,id);
create index lead_assignment on public.leads(tenant_id,assignee_id,created_at desc,id);
create index lead_email_match on public.leads(tenant_id,lower(trim(email)));
create table public.messages (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null, lead_id uuid not null,
 direction text not null check(direction in ('INBOUND','OUTBOUND','INTERNAL')),
 channel text not null check(channel in ('MANUAL','WEBSITE')), body text not null check(char_length(trim(body)) between 1 and 10000),
 occurred_at timestamptz not null, created_at timestamptz not null default now(),
 foreign key(tenant_id,lead_id) references public.leads(tenant_id,id), unique(tenant_id,id)
);
create table public.activity_events (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null, lead_id uuid not null,
 actor_id uuid references auth.users(id), event_type text not null, reason text, request_id uuid not null,
 created_at timestamptz not null default now(), foreign key(tenant_id,lead_id) references public.leads(tenant_id,id)
);
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;
-- Fixed identity and search path. No caller-selected actor or tenant authority.
create function private.can_read_lead(p_tenant uuid, p_assignee uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.tenant_id=p_tenant and m.user_id=(select auth.uid())
 and m.active and (m.role in ('OWNER','ADMIN') or m.id=p_assignee));
$$;
create function private.has_membership(p_tenant uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.tenant_id=p_tenant and m.user_id=(select auth.uid()) and m.active);
$$;
revoke all on function private.can_read_lead(uuid,uuid), private.has_membership(uuid) from public;
grant execute on function private.can_read_lead(uuid,uuid), private.has_membership(uuid) to authenticated;
alter table public.agencies enable row level security;
alter table public.memberships enable row level security;
alter table public.leads enable row level security;
alter table public.messages enable row level security;
alter table public.activity_events enable row level security;
create policy agency_read on public.agencies for select to authenticated using(private.has_membership(id));
create policy own_membership_read on public.memberships for select to authenticated using(user_id=(select auth.uid()) and active);
create policy lead_read on public.leads for select to authenticated using(private.can_read_lead(tenant_id,assignee_id));
create policy message_read on public.messages for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=messages.tenant_id and l.id=messages.lead_id));
create policy activity_read on public.activity_events for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=activity_events.tenant_id and l.id=activity_events.lead_id));
-- Default deny mutations until services enforce versions, lifecycle and atomic audit.
revoke all on public.agencies,public.memberships,public.leads,public.messages,public.activity_events from anon,authenticated;
grant select on public.agencies,public.memberships,public.leads,public.messages,public.activity_events to authenticated;

-- Source: 202610060002_services.sql
-- Authenticated transactional services. No service-role client is used by user APIs.

alter table public.messages add column author_id uuid references auth.users(id), add column delivery_status text check(delivery_status is null or delivery_status='USER_REPORTED');
alter table public.activity_events add constraint activity_tenant_fk foreign key(tenant_id) references public.agencies(id);
alter table public.leads add column budget_min numeric, add column budget_max numeric,
 add column currency text, add column duplicate_review boolean not null default false;
alter table public.leads add constraint lead_budget_check check (
 (budget_min is null or budget_min>=0) and (budget_max is null or budget_max>=0)
 and (budget_min is null or budget_max is null or budget_max>=budget_min)
 and ((budget_min is null and budget_max is null) or currency in ('AED','USD','EUR','GBP','SAR'))
);
alter table public.activity_events alter column lead_id drop not null;
create policy agency_activity_read on public.activity_events for select to authenticated
 using(lead_id is null and exists(select 1 from public.memberships m where m.tenant_id=activity_events.tenant_id
 and m.user_id=(select auth.uid()) and m.active and m.role in ('OWNER','ADMIN')));
create table private.api_requests (
 actor_id uuid not null, operation text not null, request_key uuid not null, payload_hash text not null,
 tenant_id uuid not null, response jsonb not null, created_at timestamptz not null default now(),
 primary key(actor_id,operation,request_key)
);
revoke all on private.api_requests from public,anon,authenticated;

create function private.verified_actor() returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid := auth.uid();
begin
 if actor is null or not exists(select 1 from auth.users u where u.id=actor and u.email_confirmed_at is not null) then
  raise exception 'AUTH_REQUIRED' using errcode='P0001';
 end if;
 return actor;
end; $$;
create function private.active_member(p_tenant uuid) returns public.memberships
language plpgsql security definer set search_path='' as $$
declare result public.memberships; actor uuid := private.verified_actor();
begin
 select * into result from public.memberships m where m.tenant_id=p_tenant and m.user_id=actor and m.active for share;
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 return result;
end; $$;
create function private.validate_lead(p_payload jsonb) returns void
language plpgsql set search_path='' as $$
declare lo numeric; hi numeric;
begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(
  select 1 from jsonb_object_keys(p_payload) k where k not in ('full_name','email','phone','initial_message','budget_min','budget_max','currency','assignee_id')
 ) then raise exception 'VALIDATION_FAILED'; end if;
 if jsonb_typeof(p_payload->'full_name') is distinct from 'string' or char_length(trim(p_payload->>'full_name')) not between 2 and 120 then raise exception 'VALIDATION_FAILED'; end if;
 if p_payload ? 'email' and jsonb_typeof(p_payload->'email') is distinct from 'string' then raise exception 'VALIDATION_FAILED'; end if;
 if p_payload ? 'phone' and jsonb_typeof(p_payload->'phone') is distinct from 'string' then raise exception 'VALIDATION_FAILED'; end if;
 if coalesce(p_payload->>'email','')<>'' and (char_length(p_payload->>'email')>254 or p_payload->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'VALIDATION_FAILED'; end if;
 if coalesce(p_payload->>'phone','')<>'' and p_payload->>'phone' !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'VALIDATION_FAILED'; end if;
 if coalesce(p_payload->>'email','')='' and coalesce(p_payload->>'phone','')='' then raise exception 'VALIDATION_FAILED'; end if;
 if p_payload ? 'initial_message' and (jsonb_typeof(p_payload->'initial_message') is distinct from 'string' or char_length(p_payload->>'initial_message')>10000) then raise exception 'VALIDATION_FAILED'; end if;
 if p_payload ? 'budget_min' and p_payload->'budget_min'<>'null'::jsonb then
  if jsonb_typeof(p_payload->'budget_min')<>'number' or char_length(p_payload->>'budget_min')>40 then raise exception 'VALIDATION_FAILED'; end if;
  lo:=(p_payload->>'budget_min')::numeric;
 end if;
 if p_payload ? 'budget_max' and p_payload->'budget_max'<>'null'::jsonb then
  if jsonb_typeof(p_payload->'budget_max')<>'number' or char_length(p_payload->>'budget_max')>40 then raise exception 'VALIDATION_FAILED'; end if;
  hi:=(p_payload->>'budget_max')::numeric;
 end if;
 if lo<0 or hi<0 or lo>hi then raise exception 'VALIDATION_FAILED'; end if;
 if (lo is not null or hi is not null) and coalesce(p_payload->>'currency','') not in ('AED','USD','EUR','GBP','SAR') then raise exception 'VALIDATION_FAILED'; end if;
 if p_payload->>'currency' is not null and p_payload->>'currency' not in ('AED','USD','EUR','GBP','SAR') then raise exception 'VALIDATION_FAILED'; end if;
end; $$;

create function public.create_agency(p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.verified_actor(); agency public.agencies; member public.memberships;
 prior private.api_requests; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('name','timezone','locale'))
 or jsonb_typeof(p_payload->'name') is distinct from 'string' or char_length(trim(p_payload->>'name')) not between 2 and 120
 or coalesce(p_payload->>'locale','en')<>'en' or not exists(select 1 from pg_catalog.pg_timezone_names where name=coalesce(p_payload->>'timezone','Asia/Dubai')) then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||'agency'||p_key::text,0));
 select * into prior from private.api_requests where actor_id=actor and operation='agency' and request_key=p_key;
 if found then
  perform private.active_member(prior.tenant_id);
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return prior.response;
 end if;
 insert into public.agencies(name,timezone,locale) values(trim(p_payload->>'name'),coalesce(p_payload->>'timezone','Asia/Dubai'),'en') returning * into agency;
 insert into public.memberships(tenant_id,user_id,role) values(agency.id,actor,'OWNER') returning * into member;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id) values(agency.id,actor,'AGENCY_CREATED',p_request_id);
 result:=jsonb_build_object('agency',to_jsonb(agency),'membership',to_jsonb(member));
 insert into private.api_requests values(actor,'agency',p_key,payload_hash,agency.id,result,now());
 return result;
end; $$;

create function public.create_lead(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); actor uuid:=auth.uid(); assignee uuid;
 lead public.leads; prior private.api_requests; v_operation text:='lead:'||p_tenant::text;
 payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb; duplicate boolean;
begin
 perform private.validate_lead(p_payload);
 if p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||v_operation||p_key::text,0));
 select * into prior from private.api_requests where actor_id=actor and api_requests.operation=v_operation and request_key=p_key;
 if found then
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if not exists(select 1 from public.leads l where l.tenant_id=p_tenant and l.id=(prior.response->>'id')::uuid and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id)) then raise exception 'NOT_FOUND'; end if;
  return prior.response;
 end if;
 if member.role='AGENT' then
  assignee:=member.id;
  if p_payload->>'assignee_id' is not null and p_payload->>'assignee_id'<>member.id::text then raise exception 'VALIDATION_FAILED'; end if;
 elsif p_payload->>'assignee_id' is not null then
  begin assignee:=(p_payload->>'assignee_id')::uuid; exception when invalid_text_representation then raise exception 'VALIDATION_FAILED'; end;
 end if;
 if assignee is not null and not exists(select 1 from public.memberships m where m.tenant_id=p_tenant and m.id=assignee and m.active) then raise exception 'VALIDATION_FAILED'; end if;
 select exists(select 1 from public.leads l where l.tenant_id=p_tenant and
 ((coalesce(p_payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(p_payload->>'email'))) or
 (coalesce(p_payload->>'phone','')<>'' and l.phone=p_payload->>'phone'))) into duplicate;
 insert into public.leads(tenant_id,assignee_id,full_name,email,phone,source,created_by,budget_min,budget_max,currency,duplicate_review)
 values(p_tenant,assignee,trim(p_payload->>'full_name'),nullif(lower(trim(p_payload->>'email')),''),nullif(p_payload->>'phone',''),'MANUAL',actor,
 (p_payload->>'budget_min')::numeric,(p_payload->>'budget_max')::numeric,p_payload->>'currency',duplicate) returning * into lead;
 if coalesce(trim(p_payload->>'initial_message'),'')<>'' then
  insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at,author_id) values(p_tenant,lead.id,'INBOUND','MANUAL',trim(p_payload->>'initial_message'),now(),actor);
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id) values(p_tenant,lead.id,actor,'LEAD_CREATED',p_request_id);
 result:=to_jsonb(lead);
 insert into private.api_requests values(actor,v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create function public.list_leads(p_tenant uuid,p_limit integer default 25,p_query text default '',p_status public.lead_status default null,p_cursor_time timestamptz default null,p_cursor_id uuid default null)
returns setof public.leads language sql stable security invoker set search_path='' as $$
 select l.* from public.leads l where l.tenant_id=p_tenant and l.archived_at is null
 and (p_status is null or l.status=p_status)
 and (coalesce(p_query,'')='' or strpos(lower(l.full_name),lower(p_query))>0 or strpos(lower(coalesce(l.email,'')),lower(p_query))>0 or strpos(coalesce(l.phone,''),p_query)>0)
 and (p_cursor_time is null or (l.created_at,l.id)<(p_cursor_time,p_cursor_id))
 order by l.created_at desc,l.id desc limit least(greatest(p_limit,1),101);
$$;

create function public.add_lead_message(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); lead public.leads; msg public.messages; prior private.api_requests;
 v_operation text:='message:'||p_tenant::text||':'||p_lead::text; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); occurred timestamptz; result jsonb;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('direction','body','occurred_at','expected_version'))
 or jsonb_typeof(p_payload->'body') is distinct from 'string' or char_length(trim(p_payload->>'body')) not between 1 and 10000
 or coalesce(p_payload->>'direction','') not in ('INBOUND','OUTBOUND','INTERNAL') or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 begin
  occurred:=(p_payload->>'occurred_at')::timestamptz;
  if occurred is null or not isfinite(occurred) or occurred>now() then raise exception 'VALIDATION_FAILED'; end if;
 exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests where actor_id=auth.uid() and api_requests.operation=v_operation and request_key=p_key;
 if found then
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return prior.response;
 end if;
 if p_payload->>'expected_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if lead.archived_at is not null or (p_payload->>'direction'='OUTBOUND' and (lead.do_not_contact or lead.status in ('WON','LOST'))) then raise exception 'CONTACT_BLOCKED'; end if;
 insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at,author_id,delivery_status) values(p_tenant,p_lead,p_payload->>'direction','MANUAL',trim(p_payload->>'body'),occurred,auth.uid(),case when p_payload->>'direction'='OUTBOUND' then 'USER_REPORTED' else null end) returning * into msg;
 update public.leads set version=version+1,context_version=context_version+case when msg.direction='INBOUND' then 1 else 0 end where id=p_lead and tenant_id=p_tenant returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id) values(p_tenant,p_lead,auth.uid(),'MESSAGE_LOGGED',p_request_id);
 result:=jsonb_build_object('message',to_jsonb(msg),'lead_version',lead.version,'context_version',lead.context_version,'delivery_status',case when msg.direction='OUTBOUND' then 'USER_REPORTED' else null end);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

-- Helper functions can only be reached through the explicitly granted public RPCs.
revoke all on function private.verified_actor(),private.active_member(uuid),private.validate_lead(jsonb) from public,anon,authenticated;
revoke all on function public.create_agency(jsonb,uuid,uuid), public.create_lead(uuid,jsonb,uuid,uuid), public.list_leads(uuid,integer,text,public.lead_status,timestamptz,uuid), public.add_lead_message(uuid,uuid,jsonb,uuid,uuid) from public,anon;
grant execute on function public.create_agency(jsonb,uuid,uuid), public.create_lead(uuid,jsonb,uuid,uuid), public.list_leads(uuid,integer,text,public.lead_status,timestamptz,uuid), public.add_lead_message(uuid,uuid,jsonb,uuid,uuid) to authenticated;

-- Source: 202610060003_lead_update.sql
create function public.update_lead(p_tenant uuid,p_lead uuid,p_payload jsonb,p_expected_version integer,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); lead public.leads; duplicate boolean;
begin
 if p_request_id is null or p_expected_version is null or p_expected_version<1 or p_payload ? 'initial_message' or p_payload ? 'assignee_id' then raise exception 'VALIDATION_FAILED'; end if;
 perform private.validate_lead(p_payload);
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if lead.version<>p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
 if lead.archived_at is not null then raise exception 'CONTACT_BLOCKED'; end if;
 select exists(select 1 from public.leads l where l.tenant_id=p_tenant and l.id<>p_lead and
 ((coalesce(p_payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(p_payload->>'email'))) or
 (coalesce(p_payload->>'phone','')<>'' and l.phone=p_payload->>'phone'))) into duplicate;
 update public.leads set full_name=trim(p_payload->>'full_name'),email=nullif(lower(trim(p_payload->>'email')),''),phone=nullif(p_payload->>'phone',''),
 budget_min=(p_payload->>'budget_min')::numeric,budget_max=(p_payload->>'budget_max')::numeric,currency=p_payload->>'currency',
 duplicate_review=duplicate,version=version+1,context_version=context_version+1
 where id=p_lead and tenant_id=p_tenant returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id) values(p_tenant,p_lead,auth.uid(),'LEAD_UPDATED',p_request_id);
 return to_jsonb(lead);
end; $$;
revoke all on function public.update_lead(uuid,uuid,jsonb,integer,uuid) from public,anon;
grant execute on function public.update_lead(uuid,uuid,jsonb,integer,uuid) to authenticated;

-- Source: 202610060004_workflows.sql
alter table public.activity_events add column details jsonb not null default '{}' check(jsonb_typeof(details)='object');
alter table public.leads add column confirmed_intent text check(confirmed_intent in ('BUY','RENT','SELL','INVEST','OTHER')),
 add column qualification_summary text, add column locations text[] not null default '{}', add column qualification_unknowns_ack boolean not null default false,
 add column won_at timestamptz, add column outcome_summary text, add column deal_value numeric check(deal_value>=0), add column deal_currency text,
 add column lost_reason text, add column outcome_reason text;
create table public.follow_ups (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.agencies(id), lead_id uuid not null, assignee_id uuid not null,
 type text not null check(type in ('CALL','MESSAGE','EMAIL','VIEWING','INTERNAL')), title text not null check(char_length(trim(title)) between 1 and 150),
 notes text not null default '' check(char_length(notes)<=2000), due_at timestamptz not null check(isfinite(due_at)),
 state text not null default 'OPEN' check(state in ('OPEN','COMPLETED','CANCELLED')), version integer not null default 1 check(version>0),
 schedule_version integer not null default 1 check(schedule_version>0), created_by uuid not null references auth.users(id), created_at timestamptz not null default now(),
 completed_at timestamptz, completion_summary text, cancel_reason text,
 unique(tenant_id,id), foreign key(tenant_id,lead_id) references public.leads(tenant_id,id), foreign key(tenant_id,assignee_id) references public.memberships(tenant_id,id)
);
create index follow_up_due on public.follow_ups(tenant_id,state,due_at,id);
create index follow_up_lead on public.follow_ups(tenant_id,lead_id,due_at,id);
alter table public.follow_ups enable row level security;
create policy follow_up_read on public.follow_ups for select to authenticated using(
 private.can_read_lead(tenant_id,assignee_id) and exists(select 1 from public.leads l where l.tenant_id=follow_ups.tenant_id and l.id=follow_ups.lead_id)
);
revoke all on public.follow_ups from public,anon,authenticated;
grant select on public.follow_ups to authenticated;

create function public.create_follow_up(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); lead public.leads; task public.follow_ups; target public.memberships;
 prior private.api_requests; v_operation text:='task:'||p_tenant::text; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb; due timestamptz; lead_id uuid;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('lead_id','assignee_id','type','title','notes','due_at','expected_lead_version'))
 or jsonb_typeof(p_payload->'title') is distinct from 'string' or char_length(trim(p_payload->>'title')) not between 1 and 150
 or coalesce(p_payload->>'type','') not in ('CALL','MESSAGE','EMAIL','VIEWING','INTERNAL')
 or (p_payload ? 'notes' and (jsonb_typeof(p_payload->'notes') is distinct from 'string' or char_length(p_payload->>'notes')>2000))
 or jsonb_typeof(p_payload->'due_at') is distinct from 'string' or (p_payload ? 'assignee_id' and jsonb_typeof(p_payload->'assignee_id') is distinct from 'string')
 or jsonb_typeof(p_payload->'expected_lead_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 begin lead_id:=(p_payload->>'lead_id')::uuid; due:=(p_payload->>'due_at')::timestamptz;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=lead_id and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if not exists(select 1 from public.follow_ups f where f.id=(prior.response->'follow_up'->>'id')::uuid and f.tenant_id=p_tenant and (member.role in ('OWNER','ADMIN') or f.assignee_id=member.id)) then raise exception 'NOT_FOUND'; end if;
  return prior.response;
 end if;
 if p_payload->>'expected_lead_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if due is null or not isfinite(due) or due<=now() then raise exception 'VALIDATION_FAILED'; end if;
 if lead.archived_at is not null or lead.status in ('WON','LOST') or (lead.do_not_contact and p_payload->>'type'<>'INTERNAL') then raise exception 'CONTACT_BLOCKED'; end if;
 begin
  select * into target from public.memberships m where m.tenant_id=p_tenant and m.id=coalesce((p_payload->>'assignee_id')::uuid,case when member.role='AGENT' then member.id else coalesce(lead.assignee_id,member.id) end) and m.active for share;
 exception when invalid_text_representation then raise exception 'VALIDATION_FAILED'; end;
 if target.id is null or (member.role='AGENT' and target.id<>member.id) or (target.role='AGENT' and lead.assignee_id is distinct from target.id) then raise exception 'VALIDATION_FAILED'; end if;
 insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,notes,due_at,created_by)
 values(p_tenant,lead.id,target.id,p_payload->>'type',trim(p_payload->>'title'),coalesce(trim(p_payload->>'notes'),''),due,auth.uid()) returning * into task;
 update public.leads set version=version+1 where tenant_id=p_tenant and id=lead.id returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,lead.id,auth.uid(),'FOLLOW_UP_CREATED',p_request_id,jsonb_build_object('task_id',task.id,'due_at',task.due_at,'assignee_id',task.assignee_id,'schedule_version',task.schedule_version));
 result:=jsonb_build_object('follow_up',to_jsonb(task),'lead_version',lead.version);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create function public.change_follow_up(p_tenant uuid,p_task uuid,p_action text,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); task public.follow_ups; lead public.leads; prior private.api_requests;
 v_operation text:='task-action:'||p_tenant::text||':'||p_task::text||':'||p_action; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); due timestamptz; result jsonb; old_due timestamptz; old_schedule integer;
begin
 if p_action not in ('complete','reschedule','cancel') or p_action is null or p_key is null or p_request_id is null
 or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','summary','reason','due_at'))
 or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into task from public.follow_ups f where f.tenant_id=p_tenant and f.id=p_task and (member.role in ('OWNER','ADMIN') or f.assignee_id=member.id);
 if not found then raise exception 'NOT_FOUND'; end if;
 -- Parent then child lock order matches task creation and terminal cancellation.
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=task.lead_id and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into task from public.follow_ups f where f.tenant_id=p_tenant and f.id=p_task and (member.role in ('OWNER','ADMIN') or f.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if; return prior.response; end if;
 if p_payload->>'expected_version'<>task.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if task.state<>'OPEN' then raise exception 'TASK_NOT_OPEN'; end if;
 old_due:=task.due_at;old_schedule:=task.schedule_version;
 if p_action='complete' then
  if jsonb_typeof(p_payload->'summary') is distinct from 'string' or char_length(trim(p_payload->>'summary')) not between 1 and 2000 then raise exception 'VALIDATION_FAILED'; end if;
  update public.follow_ups set state='COMPLETED',completed_at=now(),completion_summary=trim(p_payload->>'summary'),version=version+1 where tenant_id=p_tenant and id=p_task returning * into task;
 else
  if jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED'; end if;
  if p_action='reschedule' then
   begin due:=(p_payload->>'due_at')::timestamptz; exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
   if due is null or not isfinite(due) or due<=now() then raise exception 'VALIDATION_FAILED'; end if;
   if lead.archived_at is not null or lead.status in ('WON','LOST') or (lead.do_not_contact and task.type<>'INTERNAL') then raise exception 'CONTACT_BLOCKED'; end if;
   update public.follow_ups set due_at=due,schedule_version=schedule_version+1,version=version+1 where tenant_id=p_tenant and id=p_task returning * into task;
  else
   update public.follow_ups set state='CANCELLED',cancel_reason=trim(p_payload->>'reason'),version=version+1 where tenant_id=p_tenant and id=p_task returning * into task;
  end if;
 end if;
 update public.leads set version=version+1 where tenant_id=p_tenant and id=lead.id returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details) values(p_tenant,lead.id,auth.uid(),'FOLLOW_UP_'||upper(p_action),case when p_action='complete' then null else p_payload->>'reason' end,p_request_id,jsonb_build_object('task_id',task.id,'previous_due_at',old_due,'due_at',task.due_at,'previous_schedule_version',old_schedule,'schedule_version',task.schedule_version,'state',task.state));
 result:=jsonb_build_object('follow_up',to_jsonb(task),'lead_version',lead.version);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create function public.change_lead_status(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); lead public.leads; prior private.api_requests; next_status public.lead_status;
 v_operation text:='status:'||p_tenant::text||':'||p_lead::text; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb; won_time timestamptz; open_count integer; areas text[]; previous_status public.lead_status; previous_outcome jsonb;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('status','expected_version','reason','cancel_open_tasks','confirmed_intent','qualification_summary','acknowledge_unknowns','locations','won_at','outcome_summary','deal_value','deal_currency','lost_reason'))
 or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 if (p_payload ? 'reason' and (jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500))
 or (p_payload ? 'cancel_open_tasks' and jsonb_typeof(p_payload->'cancel_open_tasks') is distinct from 'boolean')
 or (p_payload ? 'acknowledge_unknowns' and jsonb_typeof(p_payload->'acknowledge_unknowns') is distinct from 'boolean') then raise exception 'VALIDATION_FAILED'; end if;
 begin next_status:=(p_payload->>'status')::public.lead_status; exception when invalid_text_representation then raise exception 'VALIDATION_FAILED'; end;
 if next_status is null then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if; return prior.response; end if;
 if p_payload->>'expected_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if lead.archived_at is not null then raise exception 'CONTACT_BLOCKED'; end if;
 previous_status:=lead.status;previous_outcome:=jsonb_build_object('won_at',lead.won_at,'outcome_summary',lead.outcome_summary,'deal_value',lead.deal_value,'deal_currency',lead.deal_currency,'lost_reason',lead.lost_reason,'reason',lead.outcome_reason);
 if not (case lead.status
  when 'NEW' then next_status in ('CONTACTED','QUALIFIED','FOLLOW_UP','LOST')
  when 'CONTACTED' then next_status in ('QUALIFIED','FOLLOW_UP','WON','LOST')
  when 'QUALIFIED' then next_status in ('CONTACTED','FOLLOW_UP','WON','LOST')
  when 'FOLLOW_UP' then next_status in ('CONTACTED','QUALIFIED','WON','LOST')
  when 'WON' then next_status in ('CONTACTED','QUALIFIED')
  when 'LOST' then next_status in ('NEW','CONTACTED') end) then raise exception 'STATUS_REQUIREMENT'; end if;
 if lead.status in ('WON','LOST') and (jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500) then raise exception 'STATUS_REQUIREMENT'; end if;
 if next_status='CONTACTED' then
  if lead.do_not_contact then raise exception 'CONTACT_BLOCKED'; end if;
  if not exists(select 1 from public.messages m where m.tenant_id=p_tenant and m.lead_id=p_lead and m.direction='OUTBOUND') then raise exception 'STATUS_REQUIREMENT'; end if;
 end if;
 if next_status='QUALIFIED' then
  if coalesce(p_payload->>'confirmed_intent','') not in ('BUY','RENT','SELL','INVEST','OTHER') or jsonb_typeof(p_payload->'qualification_summary') is distinct from 'string'
   or char_length(trim(p_payload->>'qualification_summary')) not between 5 and 1000 then raise exception 'STATUS_REQUIREMENT'; end if;
  areas:=lead.locations;
  if p_payload ? 'locations' then
   if jsonb_typeof(p_payload->'locations') is distinct from 'array' or jsonb_array_length(p_payload->'locations')>5 then raise exception 'VALIDATION_FAILED'; end if;
   if exists(select 1 from jsonb_array_elements(p_payload->'locations') a where jsonb_typeof(a)<>'string' or char_length(trim(a#>>'{}')) not between 1 and 120) then raise exception 'VALIDATION_FAILED'; end if;
   select coalesce(array_agg(distinct trim(a)),'{}') into areas from jsonb_array_elements_text(p_payload->'locations') a;
  end if;
  if ((lead.budget_min is null and lead.budget_max is null) or cardinality(areas)=0) and p_payload->'acknowledge_unknowns' is distinct from 'true'::jsonb then raise exception 'STATUS_REQUIREMENT'; end if;
  update public.leads set confirmed_intent=p_payload->>'confirmed_intent',qualification_summary=trim(p_payload->>'qualification_summary'),locations=areas,
   qualification_unknowns_ack=coalesce(p_payload->'acknowledge_unknowns'='true'::jsonb,false),context_version=context_version+1 where tenant_id=p_tenant and id=p_lead;
 end if;
 if next_status='FOLLOW_UP' then
  if lead.do_not_contact then raise exception 'CONTACT_BLOCKED'; end if;
  if not exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN') then raise exception 'STATUS_REQUIREMENT'; end if;
 end if;
 if next_status='WON' then
  begin won_time:=(p_payload->>'won_at')::timestamptz; exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
  if won_time is null or not isfinite(won_time) or won_time>now() or jsonb_typeof(p_payload->'outcome_summary') is distinct from 'string' or char_length(trim(p_payload->>'outcome_summary')) not between 5 and 1000 then raise exception 'STATUS_REQUIREMENT'; end if;
  if p_payload ? 'deal_value' and (jsonb_typeof(p_payload->'deal_value') is distinct from 'number' or char_length(p_payload->>'deal_value')>40 or (p_payload->>'deal_value')::numeric<0 or coalesce(p_payload->>'deal_currency','') not in ('AED','USD','EUR','GBP','SAR')) then raise exception 'VALIDATION_FAILED'; end if;
 end if;
 if next_status='LOST' and (coalesce(p_payload->>'lost_reason','') not in ('NO_RESPONSE','NOT_INTERESTED','BUDGET_MISMATCH','ALREADY_CLOSED','DUPLICATE','OTHER') or (p_payload->>'lost_reason'='OTHER' and (jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500))) then raise exception 'STATUS_REQUIREMENT'; end if;
 select count(*) into open_count from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
 if next_status in ('WON','LOST') and open_count>0 and p_payload->'cancel_open_tasks' is distinct from 'true'::jsonb then raise exception 'TASK_CONFIRMATION_REQUIRED'; end if;
 if next_status in ('WON','LOST') then
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
  select p_tenant,p_lead,auth.uid(),'FOLLOW_UP_CANCEL','Lead closed: '||next_status::text,p_request_id,jsonb_build_object('task_id',f.id,'state','CANCELLED','previous_version',f.version)
  from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
  update public.follow_ups set state='CANCELLED',cancel_reason='Lead closed: '||next_status::text,version=version+1 where tenant_id=p_tenant and lead_id=p_lead and state='OPEN';
 end if;
 update public.leads set status=next_status,version=version+1,
  won_at=case when next_status='WON' then won_time else null end,
  outcome_summary=case when next_status='WON' then trim(p_payload->>'outcome_summary') else null end,
  deal_value=case when next_status='WON' then (p_payload->>'deal_value')::numeric else null end,
  deal_currency=case when next_status='WON' then p_payload->>'deal_currency' else null end,
  lost_reason=case when next_status='LOST' then p_payload->>'lost_reason' else null end,
  outcome_reason=case when next_status in ('WON','LOST') then p_payload->>'reason' else null end
 where tenant_id=p_tenant and id=p_lead returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details) values(p_tenant,p_lead,auth.uid(),'STATUS_'||next_status::text,p_payload->>'reason',p_request_id,jsonb_build_object('previous_status',previous_status,'status',next_status,'previous_outcome',previous_outcome,'outcome',jsonb_build_object('won_at',lead.won_at,'outcome_summary',lead.outcome_summary,'deal_value',lead.deal_value,'deal_currency',lead.deal_currency,'lost_reason',lead.lost_reason),'cancelled_tasks',case when next_status in ('WON','LOST') then open_count else 0 end));
 result:=jsonb_build_object('lead',to_jsonb(lead),'cancelled_tasks',case when next_status in ('WON','LOST') then open_count else 0 end);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;
revoke all on function public.create_follow_up(uuid,jsonb,uuid,uuid), public.change_follow_up(uuid,uuid,text,jsonb,uuid,uuid), public.change_lead_status(uuid,uuid,jsonb,uuid,uuid) from public,anon;
grant execute on function public.create_follow_up(uuid,jsonb,uuid,uuid), public.change_follow_up(uuid,uuid,text,jsonb,uuid,uuid), public.change_lead_status(uuid,uuid,jsonb,uuid,uuid) to authenticated;

-- Source: 202610060005_lead_controls.sql
alter table public.memberships add column display_name text check(display_name is null or char_length(trim(display_name)) between 1 and 120);
alter table public.follow_ups alter column assignee_id drop not null;
-- Null task assignment is the manager queue. Existing RLS allows active managers only.
create function public.list_assignment_members(p_tenant uuid) returns table(id uuid,role public.member_role,label text)
language plpgsql stable security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);
begin
 return query select m.id,m.role,coalesce(nullif(trim(m.display_name),''),m.role::text||' · '||left(m.id::text,8))
 from public.memberships m where m.tenant_id=p_tenant and m.active and (member.role in ('OWNER','ADMIN') or m.id=member.id) order by m.role,m.id;
end; $$;
create function public.lead_control_summary(p_tenant uuid,p_lead uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare member public.memberships; lead public.leads; result jsonb;
begin
 select * into member from public.memberships m where m.tenant_id=p_tenant and m.user_id=auth.uid() and m.active;
 if not found then raise exception 'MEMBERSHIP_REQUIRED'; end if;
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead;
 if not found then raise exception 'NOT_FOUND'; end if;
 select jsonb_build_object('role',member.role,'membership_id',member.id,'lead_version',lead.version,
 'open_task_count',count(*) filter(where f.state='OPEN'),'outreach_task_count',count(*) filter(where f.state='OPEN' and f.type<>'INTERNAL'))
 into result from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead;
 return result;
end; $$;
create or replace function public.create_follow_up(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); lead public.leads; task public.follow_ups; target public.memberships;
 prior private.api_requests; v_operation text:='task:'||p_tenant::text; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb; due timestamptz; lead_id uuid;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('lead_id','assignee_id','type','title','notes','due_at','expected_lead_version'))
 or jsonb_typeof(p_payload->'title') is distinct from 'string' or char_length(trim(p_payload->>'title')) not between 1 and 150
 or coalesce(p_payload->>'type','') not in ('CALL','MESSAGE','EMAIL','VIEWING','INTERNAL')
 or (p_payload ? 'notes' and (jsonb_typeof(p_payload->'notes') is distinct from 'string' or char_length(p_payload->>'notes')>2000))
 or jsonb_typeof(p_payload->'due_at') is distinct from 'string' or (p_payload ? 'assignee_id' and jsonb_typeof(p_payload->'assignee_id') is distinct from 'string')
 or jsonb_typeof(p_payload->'expected_lead_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 begin lead_id:=(p_payload->>'lead_id')::uuid; due:=(p_payload->>'due_at')::timestamptz;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=lead_id and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if not exists(select 1 from public.follow_ups f where f.id=(prior.response->'follow_up'->>'id')::uuid and f.tenant_id=p_tenant and (member.role in ('OWNER','ADMIN') or f.assignee_id=member.id)) then raise exception 'NOT_FOUND'; end if;
  return prior.response;
 end if;
 if p_payload->>'expected_lead_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if due is null or not isfinite(due) or due<=now() then raise exception 'VALIDATION_FAILED'; end if;
 if lead.archived_at is not null or lead.status in ('WON','LOST') or (lead.do_not_contact and p_payload->>'type'<>'INTERNAL') then raise exception 'CONTACT_BLOCKED'; end if;
 if member.role='AGENT' or lead.assignee_id is not null or p_payload ? 'assignee_id' then
  begin
   select * into target from public.memberships m where m.tenant_id=p_tenant and m.id=coalesce((p_payload->>'assignee_id')::uuid,case when member.role='AGENT' then member.id else lead.assignee_id end) and m.active for share;
  exception when invalid_text_representation then raise exception 'VALIDATION_FAILED'; end;
  if target.id is null or (member.role='AGENT' and target.id<>member.id) or (target.role='AGENT' and lead.assignee_id is distinct from target.id) then raise exception 'VALIDATION_FAILED'; end if;
 end if;
 insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,notes,due_at,created_by)
 values(p_tenant,lead.id,target.id,p_payload->>'type',trim(p_payload->>'title'),coalesce(trim(p_payload->>'notes'),''),due,auth.uid()) returning * into task;
 update public.leads set version=version+1 where tenant_id=p_tenant and id=lead.id returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,lead.id,auth.uid(),'FOLLOW_UP_CREATED',p_request_id,jsonb_build_object('task_id',task.id,'due_at',task.due_at,'assignee_id',task.assignee_id,'schedule_version',task.schedule_version));
 result:=jsonb_build_object('follow_up',to_jsonb(task),'lead_version',lead.version);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;


create function public.mutate_lead_control(p_tenant uuid,p_lead uuid,p_action text,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); lead public.leads; target public.memberships; prior private.api_requests;
 v_operation text:='lead-control:'||p_tenant::text||':'||p_lead::text||':'||p_action; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 result jsonb; task_count integer:=0; previous_assignee uuid; previous_preference boolean; previous_archive timestamptz; target_id uuid; event text; preference boolean;
begin
 if p_action is null or p_action not in ('assignment','archive','restore','contact-preference') or p_key is null or p_request_id is null
 or jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload->'expected_version') is distinct from 'number'
 or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500
 or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','reason') and not
 (p_action='assignment' and k in ('assignee_id','transfer_open_tasks') or p_action='archive' and k='cancel_open_tasks' or p_action='contact-preference' and k='do_not_contact'))
 then raise exception 'VALIDATION_FAILED'; end if;
 if p_action='assignment' and (not p_payload ? 'assignee_id' or jsonb_typeof(p_payload->'assignee_id') not in ('null','string') or (p_payload ? 'transfer_open_tasks' and jsonb_typeof(p_payload->'transfer_open_tasks') is distinct from 'boolean')) then raise exception 'VALIDATION_FAILED'; end if;
 if p_action='archive' and p_payload ? 'cancel_open_tasks' and jsonb_typeof(p_payload->'cancel_open_tasks') is distinct from 'boolean' then raise exception 'VALIDATION_FAILED'; end if;
 if p_action='contact-preference' then
  if jsonb_typeof(p_payload->'do_not_contact') is distinct from 'boolean' then raise exception 'VALIDATION_FAILED'; end if;
  preference:=(p_payload->>'do_not_contact')::boolean;
 end if;
 if (p_action<>'contact-preference' or not preference) and member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;return prior.response;end if;
 if p_payload->>'expected_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 previous_assignee:=lead.assignee_id;previous_preference:=lead.do_not_contact;previous_archive:=lead.archived_at;
 if p_action='assignment' then
  if lead.archived_at is not null then raise exception 'CONTACT_BLOCKED'; end if;
  begin target_id:=(p_payload->>'assignee_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;
  if target_id is not null then
   select * into target from public.memberships m where m.tenant_id=p_tenant and m.id=target_id and m.active for share;
   if not found then raise exception 'VALIDATION_FAILED'; end if;
  end if;
  if lead.assignee_id is not distinct from target_id then raise exception 'STATE_CONFLICT'; end if;
  select count(*) into task_count from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
  if task_count>0 and p_payload->'transfer_open_tasks' is distinct from 'true'::jsonb then raise exception 'TASK_TRANSFER_CONFIRMATION_REQUIRED'; end if;
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
  select p_tenant,p_lead,auth.uid(),'FOLLOW_UP_REASSIGNED',trim(p_payload->>'reason'),p_request_id,
   jsonb_build_object('task_id',f.id,'previous_assignee_id',f.assignee_id,'assignee_id',target_id,'previous_schedule_version',f.schedule_version,'schedule_version',f.schedule_version+1)
   from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
  update public.follow_ups set assignee_id=target_id,version=version+1,schedule_version=schedule_version+1 where tenant_id=p_tenant and lead_id=p_lead and state='OPEN';
  update public.leads set assignee_id=target_id,version=version+1 where tenant_id=p_tenant and id=p_lead returning * into lead;
  event:='LEAD_ASSIGNED';
 elsif p_action='restore' then
  if lead.archived_at is null then raise exception 'STATE_CONFLICT'; end if;
  update public.leads set archived_at=null,version=version+1 where tenant_id=p_tenant and id=p_lead returning * into lead;
  event:='LEAD_RESTORED';
 else
  if p_action='archive' then
   if lead.archived_at is not null then raise exception 'STATE_CONFLICT'; end if;
   select count(*) into task_count from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
   if task_count>0 and p_payload->'cancel_open_tasks' is distinct from 'true'::jsonb then raise exception 'TASK_CONFIRMATION_REQUIRED'; end if;
   event:='LEAD_ARCHIVED';
  else
   if lead.do_not_contact=preference then raise exception 'STATE_CONFLICT'; end if;
   event:=case when preference then 'CONTACT_BLOCKED' else 'CONTACT_PERMISSION_RESTORED' end;
  end if;
  if p_action='archive' or preference then
   insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
   select p_tenant,p_lead,auth.uid(),'FOLLOW_UP_CANCEL',trim(p_payload->>'reason'),p_request_id,jsonb_build_object('task_id',f.id,'cause',event,'previous_version',f.version)
    from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN' and (p_action='archive' or f.type<>'INTERNAL');
   update public.follow_ups set state='CANCELLED',cancel_reason=trim(p_payload->>'reason'),version=version+1
    where tenant_id=p_tenant and lead_id=p_lead and state='OPEN' and (p_action='archive' or type<>'INTERNAL');
   get diagnostics task_count=row_count;
  end if;
  update public.leads set archived_at=case when p_action='archive' then now() else archived_at end,
   do_not_contact=case when p_action='contact-preference' then preference else do_not_contact end,
   version=version+1,context_version=context_version+case when p_action='contact-preference' then 1 else 0 end
   where tenant_id=p_tenant and id=p_lead returning * into lead;
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
 values(p_tenant,p_lead,auth.uid(),event,trim(p_payload->>'reason'),p_request_id,jsonb_build_object('previous_assignee_id',previous_assignee,'assignee_id',lead.assignee_id,
 'previous_do_not_contact',previous_preference,'do_not_contact',lead.do_not_contact,'previous_archived_at',previous_archive,'archived_at',lead.archived_at,'affected_open_tasks',task_count));
 result:=jsonb_build_object('lead',to_jsonb(lead),'affected_open_tasks',task_count);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());return result;
end; $$;

-- Replace the inbox RPC rather than creating ambiguous PostgREST overloads.
drop function public.list_leads(uuid,integer,text,public.lead_status,timestamptz,uuid);
create function public.list_leads(p_tenant uuid,p_limit integer default 25,p_query text default '',p_status public.lead_status default null,p_cursor_time timestamptz default null,p_cursor_id uuid default null,p_archived boolean default false)
returns setof public.leads language sql stable security invoker set search_path='' as $$
 select l.* from public.leads l where l.tenant_id=p_tenant and (l.archived_at is not null)=p_archived
 and (p_status is null or l.status=p_status)
 and (coalesce(p_query,'')='' or strpos(lower(l.full_name),lower(p_query))>0 or strpos(lower(coalesce(l.email,'')),lower(p_query))>0 or strpos(coalesce(l.phone,''),p_query)>0 or exists(select 1 from unnest(l.locations) area where strpos(lower(area),lower(p_query))>0))
 and (p_cursor_time is null or (l.created_at,l.id)<(p_cursor_time,p_cursor_id))
 order by l.created_at desc,l.id desc limit least(greatest(p_limit,1),101);
$$;
revoke all on function public.list_assignment_members(uuid),public.lead_control_summary(uuid,uuid),public.mutate_lead_control(uuid,uuid,text,jsonb,uuid,uuid),public.list_leads(uuid,integer,text,public.lead_status,timestamptz,uuid,boolean) from public,anon;
grant execute on function public.list_assignment_members(uuid),public.lead_control_summary(uuid,uuid),public.mutate_lead_control(uuid,uuid,text,jsonb,uuid,uuid),public.list_leads(uuid,integer,text,public.lead_status,timestamptz,uuid,boolean) to authenticated;

-- Source: 202610060006_team.sql
alter table public.memberships add column version integer not null default 1 check(version>0),add column created_at timestamptz not null default now(),add column deactivated_at timestamptz;
alter table public.agencies add column seat_limit integer check(seat_limit between 1 and 10000),add column ai_monthly_limit integer check(ai_monthly_limit between 0 and 1000000),
 add column processing_approved boolean not null default false,add column processing_reference text check(processing_reference is null or char_length(processing_reference)<=500);
revoke select on public.agencies from authenticated;
grant select(id,name,timezone,locale,ai_enabled,version,created_at,processing_approved) on public.agencies to authenticated;
create table public.invitations(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),email text not null,role public.member_role not null check(role in ('ADMIN','AGENT')),
 token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),state text not null default 'PENDING' check(state in ('PENDING','REVOKED','CONSUMED')),
 expires_at timestamptz not null default now()+interval '72 hours',version integer not null default 1 check(version>0),created_at timestamptz not null default now(),created_by uuid not null references auth.users(id),
 inviter_member_id uuid not null,consumed_by uuid references auth.users(id),foreign key(tenant_id,inviter_member_id) references public.memberships(tenant_id,id));
create index membership_directory on public.memberships(tenant_id,created_at,id);
create index invitation_directory on public.invitations(tenant_id,created_at,id);
create index invitation_seats on public.invitations(tenant_id,state,expires_at);
alter table public.invitations enable row level security;
create policy invitation_read on public.invitations for select to authenticated using(exists(select 1 from public.memberships m where m.tenant_id=invitations.tenant_id and m.user_id=auth.uid() and m.active and (m.role='OWNER' or m.role='ADMIN' and invitations.role='AGENT')));
revoke all on public.invitations from public,anon,authenticated;
grant select(id,tenant_id,email,role,state,expires_at,version,created_at,created_by) on public.invitations to authenticated;
create table private.outbox_events(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),event_type text not null,entity_id uuid not null,payload jsonb not null default '{}',
 dedupe_key text not null,state text not null default 'PENDING',created_at timestamptz not null default now(),unique(tenant_id,dedupe_key));
revoke all on private.outbox_events from public,anon,authenticated;
-- Serialize tenant writes before membership/lead/task locks so offboarding and seat reservations have a consistent lock order.
create function private.writer_member(p_tenant uuid) returns public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.verified_actor();result public.memberships;
begin
 if not exists(select 1 from public.memberships m where m.tenant_id=p_tenant and m.user_id=actor and m.active) then raise exception 'MEMBERSHIP_REQUIRED';end if;
 perform 1 from public.agencies a where a.id=p_tenant for update;
 result:=private.active_member(p_tenant);return result;
end; $$;
create function private.require_recent_mfa() returns void language plpgsql security definer set search_path='' as $$
declare claims jsonb:=auth.jwt();entry jsonb;stamp numeric;
begin
 if claims->>'aal' is distinct from 'aal2' or jsonb_typeof(claims->'amr') is distinct from 'array' then raise exception 'RECENT_MFA_REQUIRED';end if;
 for entry in select value from jsonb_array_elements(claims->'amr') loop
  if entry->>'method' in ('totp','mfa/totp') and jsonb_typeof(entry->'timestamp')='number' then
   stamp:=(entry->>'timestamp')::numeric;
   if stamp between extract(epoch from now())-300 and extract(epoch from now()) then return;end if;
  end if;
 end loop;
 raise exception 'RECENT_MFA_REQUIRED';
end; $$;
create function private.seat_count(p_tenant uuid) returns integer language sql stable security definer set search_path='' as $$
 select (select count(*) from public.memberships m where m.tenant_id=p_tenant and m.active)+(select count(*) from public.invitations i where i.tenant_id=p_tenant and i.state='PENDING' and i.expires_at>now());
$$;
revoke all on function private.writer_member(uuid),private.require_recent_mfa(),private.seat_count(uuid) from public,anon,authenticated;

create or replace function public.create_lead(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant); actor uuid:=auth.uid(); assignee uuid;
 lead public.leads; prior private.api_requests; v_operation text:='lead:'||p_tenant::text;
 payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb; duplicate boolean;
begin
 perform private.validate_lead(p_payload);
 if p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||v_operation||p_key::text,0));
 select * into prior from private.api_requests where actor_id=actor and api_requests.operation=v_operation and request_key=p_key;
 if found then
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if not exists(select 1 from public.leads l where l.tenant_id=p_tenant and l.id=(prior.response->>'id')::uuid and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id)) then raise exception 'NOT_FOUND'; end if;
  return prior.response;
 end if;
 if member.role='AGENT' then
  assignee:=member.id;
  if p_payload->>'assignee_id' is not null and p_payload->>'assignee_id'<>member.id::text then raise exception 'VALIDATION_FAILED'; end if;
 elsif p_payload->>'assignee_id' is not null then
  begin assignee:=(p_payload->>'assignee_id')::uuid; exception when invalid_text_representation then raise exception 'VALIDATION_FAILED'; end;
 end if;
 if assignee is not null and not exists(select 1 from public.memberships m where m.tenant_id=p_tenant and m.id=assignee and m.active) then raise exception 'VALIDATION_FAILED'; end if;
 select exists(select 1 from public.leads l where l.tenant_id=p_tenant and
 ((coalesce(p_payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(p_payload->>'email'))) or
 (coalesce(p_payload->>'phone','')<>'' and l.phone=p_payload->>'phone'))) into duplicate;
 insert into public.leads(tenant_id,assignee_id,full_name,email,phone,source,created_by,budget_min,budget_max,currency,duplicate_review)
 values(p_tenant,assignee,trim(p_payload->>'full_name'),nullif(lower(trim(p_payload->>'email')),''),nullif(p_payload->>'phone',''),'MANUAL',actor,
 (p_payload->>'budget_min')::numeric,(p_payload->>'budget_max')::numeric,p_payload->>'currency',duplicate) returning * into lead;
 if coalesce(trim(p_payload->>'initial_message'),'')<>'' then
  insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at,author_id) values(p_tenant,lead.id,'INBOUND','MANUAL',trim(p_payload->>'initial_message'),now(),actor);
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id) values(p_tenant,lead.id,actor,'LEAD_CREATED',p_request_id);
 result:=to_jsonb(lead);
 insert into private.api_requests values(actor,v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create or replace function public.add_lead_message(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant); lead public.leads; msg public.messages; prior private.api_requests;
 v_operation text:='message:'||p_tenant::text||':'||p_lead::text; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); occurred timestamptz; result jsonb;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('direction','body','occurred_at','expected_version'))
 or jsonb_typeof(p_payload->'body') is distinct from 'string' or char_length(trim(p_payload->>'body')) not between 1 and 10000
 or coalesce(p_payload->>'direction','') not in ('INBOUND','OUTBOUND','INTERNAL') or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 begin
  occurred:=(p_payload->>'occurred_at')::timestamptz;
  if occurred is null or not isfinite(occurred) or occurred>now() then raise exception 'VALIDATION_FAILED'; end if;
 exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests where actor_id=auth.uid() and api_requests.operation=v_operation and request_key=p_key;
 if found then
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return prior.response;
 end if;
 if p_payload->>'expected_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if lead.archived_at is not null or (p_payload->>'direction'='OUTBOUND' and (lead.do_not_contact or lead.status in ('WON','LOST'))) then raise exception 'CONTACT_BLOCKED'; end if;
 insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at,author_id,delivery_status) values(p_tenant,p_lead,p_payload->>'direction','MANUAL',trim(p_payload->>'body'),occurred,auth.uid(),case when p_payload->>'direction'='OUTBOUND' then 'USER_REPORTED' else null end) returning * into msg;
 update public.leads set version=version+1,context_version=context_version+case when msg.direction='INBOUND' then 1 else 0 end where id=p_lead and tenant_id=p_tenant returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id) values(p_tenant,p_lead,auth.uid(),'MESSAGE_LOGGED',p_request_id);
 result:=jsonb_build_object('message',to_jsonb(msg),'lead_version',lead.version,'context_version',lead.context_version,'delivery_status',case when msg.direction='OUTBOUND' then 'USER_REPORTED' else null end);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create or replace function public.update_lead(p_tenant uuid,p_lead uuid,p_payload jsonb,p_expected_version integer,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant); lead public.leads; duplicate boolean;
begin
 if p_request_id is null or p_expected_version is null or p_expected_version<1 or p_payload ? 'initial_message' or p_payload ? 'assignee_id' then raise exception 'VALIDATION_FAILED'; end if;
 perform private.validate_lead(p_payload);
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if lead.version<>p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
 if lead.archived_at is not null then raise exception 'CONTACT_BLOCKED'; end if;
 select exists(select 1 from public.leads l where l.tenant_id=p_tenant and l.id<>p_lead and
 ((coalesce(p_payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(p_payload->>'email'))) or
 (coalesce(p_payload->>'phone','')<>'' and l.phone=p_payload->>'phone'))) into duplicate;
 update public.leads set full_name=trim(p_payload->>'full_name'),email=nullif(lower(trim(p_payload->>'email')),''),phone=nullif(p_payload->>'phone',''),
 budget_min=(p_payload->>'budget_min')::numeric,budget_max=(p_payload->>'budget_max')::numeric,currency=p_payload->>'currency',
 duplicate_review=duplicate,version=version+1,context_version=context_version+1
 where id=p_lead and tenant_id=p_tenant returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id) values(p_tenant,p_lead,auth.uid(),'LEAD_UPDATED',p_request_id);
 return to_jsonb(lead);
end; $$;

create or replace function public.create_follow_up(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant); lead public.leads; task public.follow_ups; target public.memberships;
 prior private.api_requests; v_operation text:='task:'||p_tenant::text; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb; due timestamptz; lead_id uuid;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('lead_id','assignee_id','type','title','notes','due_at','expected_lead_version'))
 or jsonb_typeof(p_payload->'title') is distinct from 'string' or char_length(trim(p_payload->>'title')) not between 1 and 150
 or coalesce(p_payload->>'type','') not in ('CALL','MESSAGE','EMAIL','VIEWING','INTERNAL')
 or (p_payload ? 'notes' and (jsonb_typeof(p_payload->'notes') is distinct from 'string' or char_length(p_payload->>'notes')>2000))
 or jsonb_typeof(p_payload->'due_at') is distinct from 'string' or (p_payload ? 'assignee_id' and jsonb_typeof(p_payload->'assignee_id') is distinct from 'string')
 or jsonb_typeof(p_payload->'expected_lead_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 begin lead_id:=(p_payload->>'lead_id')::uuid; due:=(p_payload->>'due_at')::timestamptz;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=lead_id and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  if not exists(select 1 from public.follow_ups f where f.id=(prior.response->'follow_up'->>'id')::uuid and f.tenant_id=p_tenant and (member.role in ('OWNER','ADMIN') or f.assignee_id=member.id)) then raise exception 'NOT_FOUND'; end if;
  return prior.response;
 end if;
 if p_payload->>'expected_lead_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if due is null or not isfinite(due) or due<=now() then raise exception 'VALIDATION_FAILED'; end if;
 if lead.archived_at is not null or lead.status in ('WON','LOST') or (lead.do_not_contact and p_payload->>'type'<>'INTERNAL') then raise exception 'CONTACT_BLOCKED'; end if;
 if member.role='AGENT' or lead.assignee_id is not null or p_payload ? 'assignee_id' then
  begin
   select * into target from public.memberships m where m.tenant_id=p_tenant and m.id=coalesce((p_payload->>'assignee_id')::uuid,case when member.role='AGENT' then member.id else lead.assignee_id end) and m.active for share;
  exception when invalid_text_representation then raise exception 'VALIDATION_FAILED'; end;
  if target.id is null or (member.role='AGENT' and target.id<>member.id) or (target.role='AGENT' and lead.assignee_id is distinct from target.id) then raise exception 'VALIDATION_FAILED'; end if;
 end if;
 insert into public.follow_ups(tenant_id,lead_id,assignee_id,type,title,notes,due_at,created_by)
 values(p_tenant,lead.id,target.id,p_payload->>'type',trim(p_payload->>'title'),coalesce(trim(p_payload->>'notes'),''),due,auth.uid()) returning * into task;
 update public.leads set version=version+1 where tenant_id=p_tenant and id=lead.id returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,lead.id,auth.uid(),'FOLLOW_UP_CREATED',p_request_id,jsonb_build_object('task_id',task.id,'due_at',task.due_at,'assignee_id',task.assignee_id,'schedule_version',task.schedule_version));
 result:=jsonb_build_object('follow_up',to_jsonb(task),'lead_version',lead.version);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create or replace function public.change_follow_up(p_tenant uuid,p_task uuid,p_action text,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant); task public.follow_ups; lead public.leads; prior private.api_requests;
 v_operation text:='task-action:'||p_tenant::text||':'||p_task::text||':'||p_action; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); due timestamptz; result jsonb; old_due timestamptz; old_schedule integer;
begin
 if p_action not in ('complete','reschedule','cancel') or p_action is null or p_key is null or p_request_id is null
 or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','summary','reason','due_at'))
 or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into task from public.follow_ups f where f.tenant_id=p_tenant and f.id=p_task and (member.role in ('OWNER','ADMIN') or f.assignee_id=member.id);
 if not found then raise exception 'NOT_FOUND'; end if;
 -- Parent then child lock order matches task creation and terminal cancellation.
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=task.lead_id and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into task from public.follow_ups f where f.tenant_id=p_tenant and f.id=p_task and (member.role in ('OWNER','ADMIN') or f.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if; return prior.response; end if;
 if p_payload->>'expected_version'<>task.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if task.state<>'OPEN' then raise exception 'TASK_NOT_OPEN'; end if;
 old_due:=task.due_at;old_schedule:=task.schedule_version;
 if p_action='complete' then
  if jsonb_typeof(p_payload->'summary') is distinct from 'string' or char_length(trim(p_payload->>'summary')) not between 1 and 2000 then raise exception 'VALIDATION_FAILED'; end if;
  update public.follow_ups set state='COMPLETED',completed_at=now(),completion_summary=trim(p_payload->>'summary'),version=version+1 where tenant_id=p_tenant and id=p_task returning * into task;
 else
  if jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED'; end if;
  if p_action='reschedule' then
   begin due:=(p_payload->>'due_at')::timestamptz; exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
   if due is null or not isfinite(due) or due<=now() then raise exception 'VALIDATION_FAILED'; end if;
   if lead.archived_at is not null or lead.status in ('WON','LOST') or (lead.do_not_contact and task.type<>'INTERNAL') then raise exception 'CONTACT_BLOCKED'; end if;
   update public.follow_ups set due_at=due,schedule_version=schedule_version+1,version=version+1 where tenant_id=p_tenant and id=p_task returning * into task;
  else
   update public.follow_ups set state='CANCELLED',cancel_reason=trim(p_payload->>'reason'),version=version+1 where tenant_id=p_tenant and id=p_task returning * into task;
  end if;
 end if;
 update public.leads set version=version+1 where tenant_id=p_tenant and id=lead.id returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details) values(p_tenant,lead.id,auth.uid(),'FOLLOW_UP_'||upper(p_action),case when p_action='complete' then null else p_payload->>'reason' end,p_request_id,jsonb_build_object('task_id',task.id,'previous_due_at',old_due,'due_at',task.due_at,'previous_schedule_version',old_schedule,'schedule_version',task.schedule_version,'state',task.state));
 result:=jsonb_build_object('follow_up',to_jsonb(task),'lead_version',lead.version);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create or replace function public.change_lead_status(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant); lead public.leads; prior private.api_requests; next_status public.lead_status;
 v_operation text:='status:'||p_tenant::text||':'||p_lead::text; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb; won_time timestamptz; open_count integer; areas text[]; previous_status public.lead_status; previous_outcome jsonb;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('status','expected_version','reason','cancel_open_tasks','confirmed_intent','qualification_summary','acknowledge_unknowns','locations','won_at','outcome_summary','deal_value','deal_currency','lost_reason'))
 or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED'; end if;
 if (p_payload ? 'reason' and (jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500))
 or (p_payload ? 'cancel_open_tasks' and jsonb_typeof(p_payload->'cancel_open_tasks') is distinct from 'boolean')
 or (p_payload ? 'acknowledge_unknowns' and jsonb_typeof(p_payload->'acknowledge_unknowns') is distinct from 'boolean') then raise exception 'VALIDATION_FAILED'; end if;
 begin next_status:=(p_payload->>'status')::public.lead_status; exception when invalid_text_representation then raise exception 'VALIDATION_FAILED'; end;
 if next_status is null then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if; return prior.response; end if;
 if p_payload->>'expected_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 if lead.archived_at is not null then raise exception 'CONTACT_BLOCKED'; end if;
 previous_status:=lead.status;previous_outcome:=jsonb_build_object('won_at',lead.won_at,'outcome_summary',lead.outcome_summary,'deal_value',lead.deal_value,'deal_currency',lead.deal_currency,'lost_reason',lead.lost_reason,'reason',lead.outcome_reason);
 if not (case lead.status
  when 'NEW' then next_status in ('CONTACTED','QUALIFIED','FOLLOW_UP','LOST')
  when 'CONTACTED' then next_status in ('QUALIFIED','FOLLOW_UP','WON','LOST')
  when 'QUALIFIED' then next_status in ('CONTACTED','FOLLOW_UP','WON','LOST')
  when 'FOLLOW_UP' then next_status in ('CONTACTED','QUALIFIED','WON','LOST')
  when 'WON' then next_status in ('CONTACTED','QUALIFIED')
  when 'LOST' then next_status in ('NEW','CONTACTED') end) then raise exception 'STATUS_REQUIREMENT'; end if;
 if lead.status in ('WON','LOST') and (jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500) then raise exception 'STATUS_REQUIREMENT'; end if;
 if next_status='CONTACTED' then
  if lead.do_not_contact then raise exception 'CONTACT_BLOCKED'; end if;
  if not exists(select 1 from public.messages m where m.tenant_id=p_tenant and m.lead_id=p_lead and m.direction='OUTBOUND') then raise exception 'STATUS_REQUIREMENT'; end if;
 end if;
 if next_status='QUALIFIED' then
  if coalesce(p_payload->>'confirmed_intent','') not in ('BUY','RENT','SELL','INVEST','OTHER') or jsonb_typeof(p_payload->'qualification_summary') is distinct from 'string'
   or char_length(trim(p_payload->>'qualification_summary')) not between 5 and 1000 then raise exception 'STATUS_REQUIREMENT'; end if;
  areas:=lead.locations;
  if p_payload ? 'locations' then
   if jsonb_typeof(p_payload->'locations') is distinct from 'array' or jsonb_array_length(p_payload->'locations')>5 then raise exception 'VALIDATION_FAILED'; end if;
   if exists(select 1 from jsonb_array_elements(p_payload->'locations') a where jsonb_typeof(a)<>'string' or char_length(trim(a#>>'{}')) not between 1 and 120) then raise exception 'VALIDATION_FAILED'; end if;
   select coalesce(array_agg(distinct trim(a)),'{}') into areas from jsonb_array_elements_text(p_payload->'locations') a;
  end if;
  if ((lead.budget_min is null and lead.budget_max is null) or cardinality(areas)=0) and p_payload->'acknowledge_unknowns' is distinct from 'true'::jsonb then raise exception 'STATUS_REQUIREMENT'; end if;
  update public.leads set confirmed_intent=p_payload->>'confirmed_intent',qualification_summary=trim(p_payload->>'qualification_summary'),locations=areas,
   qualification_unknowns_ack=coalesce(p_payload->'acknowledge_unknowns'='true'::jsonb,false),context_version=context_version+1 where tenant_id=p_tenant and id=p_lead;
 end if;
 if next_status='FOLLOW_UP' then
  if lead.do_not_contact then raise exception 'CONTACT_BLOCKED'; end if;
  if not exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN') then raise exception 'STATUS_REQUIREMENT'; end if;
 end if;
 if next_status='WON' then
  begin won_time:=(p_payload->>'won_at')::timestamptz; exception when invalid_datetime_format or datetime_field_overflow then raise exception 'VALIDATION_FAILED'; end;
  if won_time is null or not isfinite(won_time) or won_time>now() or jsonb_typeof(p_payload->'outcome_summary') is distinct from 'string' or char_length(trim(p_payload->>'outcome_summary')) not between 5 and 1000 then raise exception 'STATUS_REQUIREMENT'; end if;
  if p_payload ? 'deal_value' and (jsonb_typeof(p_payload->'deal_value') is distinct from 'number' or char_length(p_payload->>'deal_value')>40 or (p_payload->>'deal_value')::numeric<0 or coalesce(p_payload->>'deal_currency','') not in ('AED','USD','EUR','GBP','SAR')) then raise exception 'VALIDATION_FAILED'; end if;
 end if;
 if next_status='LOST' and (coalesce(p_payload->>'lost_reason','') not in ('NO_RESPONSE','NOT_INTERESTED','BUDGET_MISMATCH','ALREADY_CLOSED','DUPLICATE','OTHER') or (p_payload->>'lost_reason'='OTHER' and (jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500))) then raise exception 'STATUS_REQUIREMENT'; end if;
 select count(*) into open_count from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
 if next_status in ('WON','LOST') and open_count>0 and p_payload->'cancel_open_tasks' is distinct from 'true'::jsonb then raise exception 'TASK_CONFIRMATION_REQUIRED'; end if;
 if next_status in ('WON','LOST') then
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
  select p_tenant,p_lead,auth.uid(),'FOLLOW_UP_CANCEL','Lead closed: '||next_status::text,p_request_id,jsonb_build_object('task_id',f.id,'state','CANCELLED','previous_version',f.version)
  from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
  update public.follow_ups set state='CANCELLED',cancel_reason='Lead closed: '||next_status::text,version=version+1 where tenant_id=p_tenant and lead_id=p_lead and state='OPEN';
 end if;
 update public.leads set status=next_status,version=version+1,
  won_at=case when next_status='WON' then won_time else null end,
  outcome_summary=case when next_status='WON' then trim(p_payload->>'outcome_summary') else null end,
  deal_value=case when next_status='WON' then (p_payload->>'deal_value')::numeric else null end,
  deal_currency=case when next_status='WON' then p_payload->>'deal_currency' else null end,
  lost_reason=case when next_status='LOST' then p_payload->>'lost_reason' else null end,
  outcome_reason=case when next_status in ('WON','LOST') then p_payload->>'reason' else null end
 where tenant_id=p_tenant and id=p_lead returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details) values(p_tenant,p_lead,auth.uid(),'STATUS_'||next_status::text,p_payload->>'reason',p_request_id,jsonb_build_object('previous_status',previous_status,'status',next_status,'previous_outcome',previous_outcome,'outcome',jsonb_build_object('won_at',lead.won_at,'outcome_summary',lead.outcome_summary,'deal_value',lead.deal_value,'deal_currency',lead.deal_currency,'lost_reason',lead.lost_reason),'cancelled_tasks',case when next_status in ('WON','LOST') then open_count else 0 end));
 result:=jsonb_build_object('lead',to_jsonb(lead),'cancelled_tasks',case when next_status in ('WON','LOST') then open_count else 0 end);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());
 return result;
end; $$;

create or replace function public.mutate_lead_control(p_tenant uuid,p_lead uuid,p_action text,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant); lead public.leads; target public.memberships; prior private.api_requests;
 v_operation text:='lead-control:'||p_tenant::text||':'||p_lead::text||':'||p_action; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 result jsonb; task_count integer:=0; previous_assignee uuid; previous_preference boolean; previous_archive timestamptz; target_id uuid; event text; preference boolean;
begin
 if p_action is null or p_action not in ('assignment','archive','restore','contact-preference') or p_key is null or p_request_id is null
 or jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload->'expected_version') is distinct from 'number'
 or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500
 or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','reason') and not
 (p_action='assignment' and k in ('assignee_id','transfer_open_tasks') or p_action='archive' and k='cancel_open_tasks' or p_action='contact-preference' and k='do_not_contact'))
 then raise exception 'VALIDATION_FAILED'; end if;
 if p_action='assignment' and (not p_payload ? 'assignee_id' or jsonb_typeof(p_payload->'assignee_id') not in ('null','string') or (p_payload ? 'transfer_open_tasks' and jsonb_typeof(p_payload->'transfer_open_tasks') is distinct from 'boolean')) then raise exception 'VALIDATION_FAILED'; end if;
 if p_action='archive' and p_payload ? 'cancel_open_tasks' and jsonb_typeof(p_payload->'cancel_open_tasks') is distinct from 'boolean' then raise exception 'VALIDATION_FAILED'; end if;
 if p_action='contact-preference' then
  if jsonb_typeof(p_payload->'do_not_contact') is distinct from 'boolean' then raise exception 'VALIDATION_FAILED'; end if;
  preference:=(p_payload->>'do_not_contact')::boolean;
 end if;
 if (p_action<>'contact-preference' or not preference) and member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||v_operation||p_key::text,0));
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;return prior.response;end if;
 if p_payload->>'expected_version'<>lead.version::text then raise exception 'VERSION_CONFLICT'; end if;
 previous_assignee:=lead.assignee_id;previous_preference:=lead.do_not_contact;previous_archive:=lead.archived_at;
 if p_action='assignment' then
  if lead.archived_at is not null then raise exception 'CONTACT_BLOCKED'; end if;
  begin target_id:=(p_payload->>'assignee_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;
  if target_id is not null then
   select * into target from public.memberships m where m.tenant_id=p_tenant and m.id=target_id and m.active for share;
   if not found then raise exception 'VALIDATION_FAILED'; end if;
  end if;
  if lead.assignee_id is not distinct from target_id then raise exception 'STATE_CONFLICT'; end if;
  select count(*) into task_count from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
  if task_count>0 and p_payload->'transfer_open_tasks' is distinct from 'true'::jsonb then raise exception 'TASK_TRANSFER_CONFIRMATION_REQUIRED'; end if;
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
  select p_tenant,p_lead,auth.uid(),'FOLLOW_UP_REASSIGNED',trim(p_payload->>'reason'),p_request_id,
   jsonb_build_object('task_id',f.id,'previous_assignee_id',f.assignee_id,'assignee_id',target_id,'previous_schedule_version',f.schedule_version,'schedule_version',f.schedule_version+1)
   from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
  update public.follow_ups set assignee_id=target_id,version=version+1,schedule_version=schedule_version+1 where tenant_id=p_tenant and lead_id=p_lead and state='OPEN';
  update public.leads set assignee_id=target_id,version=version+1 where tenant_id=p_tenant and id=p_lead returning * into lead;
  event:='LEAD_ASSIGNED';
 elsif p_action='restore' then
  if lead.archived_at is null then raise exception 'STATE_CONFLICT'; end if;
  update public.leads set archived_at=null,version=version+1 where tenant_id=p_tenant and id=p_lead returning * into lead;
  event:='LEAD_RESTORED';
 else
  if p_action='archive' then
   if lead.archived_at is not null then raise exception 'STATE_CONFLICT'; end if;
   select count(*) into task_count from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN';
   if task_count>0 and p_payload->'cancel_open_tasks' is distinct from 'true'::jsonb then raise exception 'TASK_CONFIRMATION_REQUIRED'; end if;
   event:='LEAD_ARCHIVED';
  else
   if lead.do_not_contact=preference then raise exception 'STATE_CONFLICT'; end if;
   event:=case when preference then 'CONTACT_BLOCKED' else 'CONTACT_PERMISSION_RESTORED' end;
  end if;
  if p_action='archive' or preference then
   insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
   select p_tenant,p_lead,auth.uid(),'FOLLOW_UP_CANCEL',trim(p_payload->>'reason'),p_request_id,jsonb_build_object('task_id',f.id,'cause',event,'previous_version',f.version)
    from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=p_lead and f.state='OPEN' and (p_action='archive' or f.type<>'INTERNAL');
   update public.follow_ups set state='CANCELLED',cancel_reason=trim(p_payload->>'reason'),version=version+1
    where tenant_id=p_tenant and lead_id=p_lead and state='OPEN' and (p_action='archive' or type<>'INTERNAL');
   get diagnostics task_count=row_count;
  end if;
  update public.leads set archived_at=case when p_action='archive' then now() else archived_at end,
   do_not_contact=case when p_action='contact-preference' then preference else do_not_contact end,
   version=version+1,context_version=context_version+case when p_action='contact-preference' then 1 else 0 end
   where tenant_id=p_tenant and id=p_lead returning * into lead;
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
 values(p_tenant,p_lead,auth.uid(),event,trim(p_payload->>'reason'),p_request_id,jsonb_build_object('previous_assignee_id',previous_assignee,'assignee_id',lead.assignee_id,
 'previous_do_not_contact',previous_preference,'do_not_contact',lead.do_not_contact,'previous_archived_at',previous_archive,'archived_at',lead.archived_at,'affected_open_tasks',task_count));
 result:=jsonb_build_object('lead',to_jsonb(lead),'affected_open_tasks',task_count);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,payload_hash,p_tenant,result,now());return result;
end; $$;
create function private.team_payload(p_payload jsonb,p_fields text[]) returns void language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where not k=any(p_fields)) then raise exception 'VALIDATION_FAILED';end if;
end; $$;
revoke all on function private.team_payload(jsonb,text[]) from public,anon,authenticated;

create function public.team_snapshot(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);agency public.agencies;email text;result jsonb;
begin
 select * into agency from public.agencies where id=p_tenant;select u.email into email from auth.users u where u.id=auth.uid();
 result:=jsonb_build_object('membership',jsonb_build_object('id',member.id,'role',member.role,'version',member.version,'display_name',member.display_name,'email',email),
 'agency',jsonb_build_object('id',agency.id,'name',agency.name,'timezone',agency.timezone,'locale',agency.locale,'version',agency.version,'ai_enabled',agency.ai_enabled,'processing_approved',agency.processing_approved,'processing_reference',case when member.role in ('OWNER','ADMIN') then agency.processing_reference else null end),
 'pilot',case when member.role='OWNER' then jsonb_build_object('seat_limit',agency.seat_limit,'ai_monthly_limit',agency.ai_monthly_limit,'active_seats',(select count(*) from public.memberships m where m.tenant_id=p_tenant and m.active),'pending_seats',(select count(*) from public.invitations i where i.tenant_id=p_tenant and i.state='PENDING' and i.expires_at>now())) else null end,
 'onboarding',case when member.role in ('OWNER','ADMIN') then jsonb_build_object('Agency details',char_length(agency.name)>=2,'Processing settings',agency.processing_approved,'Invite team',(select exists(select 1 from public.invitations i where i.tenant_id=p_tenant)),'Sample lead',(select exists(select 1 from public.leads l where l.tenant_id=p_tenant)),'Schedule reminder',(select exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant))) else null end);
 return result;
end; $$;
create function public.list_team_members(p_tenant uuid,p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,role public.member_role,active boolean,display_name text,email text,version integer,created_at timestamptz,lead_count bigint,open_task_count bigint)
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);
begin
 return query select m.id,m.role,m.active,m.display_name,u.email,m.version,m.created_at,
 (select count(*) from public.leads l where l.tenant_id=p_tenant and l.assignee_id=m.id),
 (select count(*) from public.follow_ups f where f.tenant_id=p_tenant and f.assignee_id=m.id and f.state='OPEN')
 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and (member.role in ('OWNER','ADMIN') or m.id=member.id)
 and (p_cursor_time is null or (m.created_at,m.id)>(p_cursor_time,p_cursor_id)) order by m.created_at,m.id limit least(greatest(p_limit,1),101);
end; $$;
create function public.list_team_invitations(p_tenant uuid,p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,email text,role public.member_role,state text,expires_at timestamptz,version integer,created_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 return query select i.id,i.email,i.role,case when i.state='PENDING' and i.expires_at<=now() then 'EXPIRED' else i.state end,i.expires_at,i.version,i.created_at
 from public.invitations i where i.tenant_id=p_tenant and (member.role='OWNER' or i.role='AGENT')
 and (p_cursor_time is null or (i.created_at,i.id)>(p_cursor_time,p_cursor_id)) order by i.created_at,i.id limit least(greatest(p_limit,1),101);
end; $$;
create function public.update_my_profile(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);prior private.api_requests;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');v_operation text:='profile:'||p_tenant::text;result jsonb;
begin
 perform private.team_payload(p_payload,array['display_name','expected_version']);
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload->'display_name') is distinct from 'string' or char_length(trim(p_payload->>'display_name')) not between 2 and 120 then raise exception 'VALIDATION_FAILED';end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.response;end if;
 if p_payload->>'expected_version' is distinct from member.version::text then raise exception 'VERSION_CONFLICT';end if;
 update public.memberships set display_name=trim(p_payload->>'display_name'),version=version+1 where tenant_id=p_tenant and id=member.id returning * into member;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'PROFILE_UPDATED',p_request_id,jsonb_build_object('member_id',member.id));
 result:=jsonb_build_object('id',member.id,'display_name',member.display_name,'version',member.version);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create function public.update_agency_settings(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);agency public.agencies;prior private.api_requests;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');v_operation text:='settings:'||p_tenant::text;result jsonb;seats integer;cap integer;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['expected_version','name','timezone','locale','processing_approved','processing_reference','ai_enabled','seat_limit','ai_monthly_limit']);
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload->'name') is distinct from 'string' or char_length(trim(p_payload->>'name')) not between 2 and 120
 or p_payload->>'locale' is distinct from 'en' or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_payload->>'timezone')
 or jsonb_typeof(p_payload->'processing_approved') is distinct from 'boolean' or jsonb_typeof(p_payload->'ai_enabled') is distinct from 'boolean'
 or jsonb_typeof(p_payload->'processing_reference') is distinct from 'string' or char_length(p_payload->>'processing_reference')>500
 or (p_payload->'processing_approved'='true'::jsonb and char_length(trim(p_payload->>'processing_reference'))<5) then raise exception 'VALIDATION_FAILED';end if;
 if member.role<>'OWNER' and (p_payload ? 'seat_limit' or p_payload ? 'ai_monthly_limit') then raise exception 'ROLE_REQUIRED';end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.response;end if;
 select * into agency from public.agencies where id=p_tenant;
 if p_payload->>'expected_version' is distinct from agency.version::text then raise exception 'VERSION_CONFLICT';end if;
 seats:=agency.seat_limit;cap:=agency.ai_monthly_limit;
 if p_payload ? 'seat_limit' then
  if p_payload->'seat_limit'='null'::jsonb then seats:=null;
  elsif jsonb_typeof(p_payload->'seat_limit')='number' and p_payload->>'seat_limit' ~ '^[0-9]{1,5}$' then seats:=(p_payload->>'seat_limit')::integer;if seats not between 1 and 10000 then raise exception 'VALIDATION_FAILED';end if;
  else raise exception 'VALIDATION_FAILED';end if;
 end if;
 if p_payload ? 'ai_monthly_limit' then
  if p_payload->'ai_monthly_limit'='null'::jsonb then cap:=null;
  elsif jsonb_typeof(p_payload->'ai_monthly_limit')='number' and p_payload->>'ai_monthly_limit' ~ '^[0-9]{1,7}$' then cap:=(p_payload->>'ai_monthly_limit')::integer;if cap not between 0 and 1000000 then raise exception 'VALIDATION_FAILED';end if;
  else raise exception 'VALIDATION_FAILED';end if;
 end if;
 if seats is not null and seats<private.seat_count(p_tenant) then raise exception 'SEAT_LIMIT_REACHED';end if;
 if p_payload->'ai_enabled'='true'::jsonb and (p_payload->'processing_approved'<>'true'::jsonb or cap is null) then raise exception 'PROCESSING_REQUIRED';end if;
 update public.agencies set name=trim(p_payload->>'name'),timezone=p_payload->>'timezone',locale='en',processing_approved=(p_payload->>'processing_approved')::boolean,
 processing_reference=nullif(trim(p_payload->>'processing_reference'),''),ai_enabled=(p_payload->>'ai_enabled')::boolean,seat_limit=seats,ai_monthly_limit=cap,version=version+1 where id=p_tenant returning * into agency;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'AGENCY_SETTINGS_UPDATED',p_request_id,jsonb_build_object('agency_version',agency.version,'processing_approved',agency.processing_approved,'ai_enabled',agency.ai_enabled));
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(p_tenant,'AGENCY_SETTINGS_CHANGED',p_tenant,v_operation||':'||p_key::text,jsonb_build_object('version',agency.version));
 result:=jsonb_build_object('id',agency.id,'version',agency.version);insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create function public.create_team_invitation(p_tenant uuid,p_payload jsonb,p_token_hash text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);invite public.invitations;prior private.api_requests;hash text:=encode(sha256(convert_to(jsonb_build_array(p_payload,p_token_hash)::text,'UTF8')),'hex');v_operation text:='invite:'||p_tenant::text;result jsonb;cap integer;v_email text;invite_role public.member_role;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['email','role']);
 if p_key is null or p_request_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_payload->'email') is distinct from 'string' or char_length(p_payload->>'email')>254
 or p_payload->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or coalesce(p_payload->>'role','') not in ('ADMIN','AGENT') then raise exception 'VALIDATION_FAILED';end if;
 v_email:=lower(trim(p_payload->>'email'));invite_role:=(p_payload->>'role')::public.member_role;
 if invite_role='ADMIN' then if member.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;perform private.require_recent_mfa();end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  select * into invite from public.invitations where id=(prior.response->>'id')::uuid and tenant_id=p_tenant;
  if invite.state<>'PENDING' or invite.expires_at<=now() or invite.token_hash<>p_token_hash then raise exception 'INVITATION_UNAVAILABLE';end if;return prior.response;
 end if;
 if exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and lower(trim(u.email))=v_email) then raise exception 'MEMBER_EXISTS';end if;
 if exists(select 1 from public.invitations i where i.tenant_id=p_tenant and i.email=v_email and i.state='PENDING' and i.expires_at>now()) then raise exception 'INVITATION_EXISTS';end if;
 select a.seat_limit into cap from public.agencies a where a.id=p_tenant;if cap is null then raise exception 'SEAT_LIMIT_REQUIRED';end if;
 if private.seat_count(p_tenant)>=cap then raise exception 'SEAT_LIMIT_REACHED';end if;
 insert into public.invitations(tenant_id,email,role,token_hash,created_by,inviter_member_id) values(p_tenant,v_email,invite_role,p_token_hash,auth.uid(),member.id) returning * into invite;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'INVITATION_CREATED',p_request_id,jsonb_build_object('invitation_id',invite.id,'role',invite.role));
 result:=to_jsonb(invite)-'token_hash'-'consumed_by';insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create function public.change_team_invitation(p_tenant uuid,p_invite uuid,p_action text,p_payload jsonb,p_token_hash text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);invite public.invitations;prior private.api_requests;hash text:=encode(sha256(convert_to(jsonb_build_array(p_payload,p_token_hash)::text,'UTF8')),'hex');v_operation text:='invite-action:'||p_tenant::text||':'||p_invite::text||':'||p_action;result jsonb;cap integer;reserved boolean;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['expected_version']);
 if p_action is null or p_action not in ('resend','revoke') or p_key is null or p_request_id is null or (p_action='resend' and (p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$')) or (p_action='revoke' and p_token_hash is not null) then raise exception 'VALIDATION_FAILED';end if;
 select * into invite from public.invitations where tenant_id=p_tenant and id=p_invite for update;if not found then raise exception 'NOT_FOUND';end if;
 if invite.role='ADMIN' and member.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;
 if p_action='resend' and invite.role='ADMIN' then perform private.require_recent_mfa();end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if p_action='resend' and (invite.state<>'PENDING' or invite.expires_at<=now() or invite.token_hash<>p_token_hash) then raise exception 'INVITATION_UNAVAILABLE';end if;return prior.response;
 end if;
 if p_payload->>'expected_version' is distinct from invite.version::text then raise exception 'VERSION_CONFLICT';end if;
 if invite.state<>'PENDING' then raise exception 'INVITATION_UNAVAILABLE';end if;
 if p_action='resend' then
  select a.seat_limit into cap from public.agencies a where a.id=p_tenant;if cap is null then raise exception 'SEAT_LIMIT_REQUIRED';end if;
  reserved:=invite.expires_at>now();if private.seat_count(p_tenant)-(case when reserved then 1 else 0 end)>=cap then raise exception 'SEAT_LIMIT_REACHED';end if;
  update public.invitations set token_hash=p_token_hash,expires_at=now()+interval '72 hours',version=version+1,created_by=auth.uid(),inviter_member_id=member.id where id=p_invite returning * into invite;
 else update public.invitations set state='REVOKED',version=version+1 where id=p_invite returning * into invite;end if;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'INVITATION_'||upper(p_action),p_request_id,jsonb_build_object('invitation_id',invite.id));
 result:=to_jsonb(invite)-'token_hash'-'consumed_by';insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create function public.accept_team_invitation(p_token_hash text,p_display_name text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.verified_actor();invite public.invitations;inviter public.memberships;member public.memberships;prior private.api_requests;email text;cap integer;v_operation text;hash text;result jsonb;
begin
 if p_key is null or p_request_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_display_name is null or char_length(trim(p_display_name)) not between 2 and 120 then raise exception 'INVITATION_UNAVAILABLE';end if;
 select * into invite from public.invitations where token_hash=p_token_hash;if not found then raise exception 'INVITATION_UNAVAILABLE';end if;
 perform 1 from public.agencies where id=invite.tenant_id for update;
 select * into invite from public.invitations where token_hash=p_token_hash for update;if not found then raise exception 'INVITATION_UNAVAILABLE';end if;
 select lower(trim(u.email)) into email from auth.users u where u.id=actor;
 if email is distinct from invite.email then raise exception 'INVITATION_UNAVAILABLE';end if;
 v_operation:='invite-accept:'||invite.id::text;hash:=encode(sha256(convert_to(jsonb_build_array(p_token_hash,trim(p_display_name))::text,'UTF8')),'hex');
 select * into prior from private.api_requests r where r.actor_id=actor and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if invite.consumed_by is distinct from actor or not exists(select 1 from public.memberships m where m.tenant_id=invite.tenant_id and m.user_id=actor and m.active) then raise exception 'INVITATION_UNAVAILABLE';end if;return prior.response;
 end if;
 if invite.state<>'PENDING' or invite.expires_at<=now() then raise exception 'INVITATION_UNAVAILABLE';end if;
 select * into inviter from public.memberships m where m.tenant_id=invite.tenant_id and m.id=invite.inviter_member_id and m.active;
 if not found or (inviter.role<>'OWNER' and (inviter.role<>'ADMIN' or invite.role<>'AGENT')) then raise exception 'INVITATION_UNAVAILABLE';end if;
 if exists(select 1 from public.memberships m where m.tenant_id=invite.tenant_id and m.user_id=actor) then raise exception 'INVITATION_UNAVAILABLE';end if;
 if invite.role='ADMIN' then perform private.require_recent_mfa();end if;
 select a.seat_limit into cap from public.agencies a where a.id=invite.tenant_id;if cap is null then raise exception 'SEAT_LIMIT_REQUIRED';end if;
 if private.seat_count(invite.tenant_id)>cap then raise exception 'SEAT_LIMIT_REACHED';end if;
 insert into public.memberships(tenant_id,user_id,role,display_name) values(invite.tenant_id,actor,invite.role,trim(p_display_name)) returning * into member;
 update public.invitations set state='CONSUMED',consumed_by=actor,version=version+1 where id=invite.id;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(invite.tenant_id,actor,'INVITATION_ACCEPTED',p_request_id,jsonb_build_object('invitation_id',invite.id,'member_id',member.id,'role',member.role));
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(invite.tenant_id,'INVITE_ACCEPTED',invite.id,v_operation,jsonb_build_object('recipient_member_id',inviter.id,'member_id',member.id));
 result:=jsonb_build_object('tenant_id',invite.tenant_id,'membership',jsonb_build_object('id',member.id,'role',member.role,'display_name',member.display_name));
 insert into private.api_requests values(actor,v_operation,p_key,hash,invite.tenant_id,result,now());return result;
end; $$;
create function public.change_team_member(p_tenant uuid,p_member uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.memberships:=private.writer_member(p_tenant);member public.memberships;replacement public.memberships;prior private.api_requests;next_role public.member_role;next_active boolean;
 hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');v_operation text:='member:'||p_tenant::text||':'||p_member::text;result jsonb;lead_record public.leads;replacement_id uuid;lead_count integer:=0;task_count integer:=0;changed integer;
begin
 if actor.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['expected_version','role','active','replacement_id','transfer_workload','reason']);
 if p_key is null or p_request_id is null or (not p_payload ? 'role' and not p_payload ? 'active') or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500
 or (p_payload ? 'active' and jsonb_typeof(p_payload->'active') is distinct from 'boolean') or (p_payload ? 'role' and coalesce(p_payload->>'role','') not in ('ADMIN','AGENT'))
 or (p_payload ? 'transfer_workload' and jsonb_typeof(p_payload->'transfer_workload') is distinct from 'boolean')
 or (p_payload ? 'replacement_id' and jsonb_typeof(p_payload->'replacement_id') not in ('null','string')) then raise exception 'VALIDATION_FAILED';end if;
 select * into member from public.memberships where tenant_id=p_tenant and id=p_member for update;if not found then raise exception 'NOT_FOUND';end if;
 if member.role='OWNER' or (actor.role='ADMIN' and (member.role<>'AGENT' or coalesce(p_payload->>'role','AGENT')<>'AGENT')) then raise exception 'ROLE_REQUIRED';end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.response;end if;
 if p_payload->>'expected_version' is distinct from member.version::text then raise exception 'VERSION_CONFLICT';end if;
 next_role:=coalesce((p_payload->>'role')::public.member_role,member.role);next_active:=coalesce((p_payload->>'active')::boolean,member.active);
 if next_role=member.role and next_active=member.active then raise exception 'STATE_CONFLICT';end if;
 if next_role='ADMIN' and member.role<>'ADMIN' then perform private.require_recent_mfa();end if;
 if not member.active and next_active then
  if (select seat_limit from public.agencies where id=p_tenant) is null then raise exception 'SEAT_LIMIT_REQUIRED';end if;
  if private.seat_count(p_tenant)>=(select seat_limit from public.agencies where id=p_tenant) then raise exception 'SEAT_LIMIT_REACHED';end if;
 end if;
 select count(*) into lead_count from public.leads l where l.tenant_id=p_tenant and l.assignee_id=p_member;
 select count(*) into task_count from public.follow_ups f where f.tenant_id=p_tenant and f.state='OPEN' and (f.assignee_id=p_member or exists(select 1 from public.leads l where l.tenant_id=p_tenant and l.id=f.lead_id and l.assignee_id=p_member));
 if member.active and (not next_active or next_role<>member.role) and (lead_count>0 or task_count>0) then
  if p_payload->'transfer_workload' is distinct from 'true'::jsonb or not p_payload ? 'replacement_id' then raise exception 'WORKLOAD_CONFIRMATION_REQUIRED';end if;
  begin replacement_id:=(p_payload->>'replacement_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;
  if replacement_id=p_member then raise exception 'VALIDATION_FAILED';end if;
  if replacement_id is not null then select * into replacement from public.memberships m where m.tenant_id=p_tenant and m.id=replacement_id and m.active for share;if not found then raise exception 'VALIDATION_FAILED';end if;end if;
  -- Agency lock serializes writers; process parents before child tasks.
  for lead_record in select * from public.leads l where l.tenant_id=p_tenant and l.assignee_id=p_member order by l.id for update loop
   insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details) values(p_tenant,lead_record.id,auth.uid(),'LEAD_ASSIGNED',trim(p_payload->>'reason'),p_request_id,jsonb_build_object('previous_assignee_id',p_member,'assignee_id',replacement_id,'cause','MEMBER_CHANGED'));
   insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
    select p_tenant,lead_record.id,auth.uid(),'FOLLOW_UP_REASSIGNED',trim(p_payload->>'reason'),p_request_id,jsonb_build_object('task_id',f.id,'previous_assignee_id',f.assignee_id,'assignee_id',replacement_id,'schedule_version',f.schedule_version+1)
    from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=lead_record.id and f.state='OPEN';
   update public.follow_ups set assignee_id=replacement_id,version=version+1,schedule_version=schedule_version+1 where tenant_id=p_tenant and lead_id=lead_record.id and state='OPEN';
   update public.leads set assignee_id=replacement_id,version=version+1 where tenant_id=p_tenant and id=lead_record.id;
   insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(p_tenant,'LEAD_ASSIGNED',lead_record.id,v_operation||':'||p_key::text||':'||lead_record.id::text,jsonb_build_object('assignee_id',replacement_id));
  end loop;
  for lead_record in select l.* from public.leads l where l.tenant_id=p_tenant and exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=l.id and f.state='OPEN' and f.assignee_id=p_member) order by l.id for update loop
   insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,reason,request_id,details)
    select p_tenant,lead_record.id,auth.uid(),'FOLLOW_UP_REASSIGNED',trim(p_payload->>'reason'),p_request_id,jsonb_build_object('task_id',f.id,'previous_assignee_id',p_member,'assignee_id',case when replacement.role in ('OWNER','ADMIN') or lead_record.assignee_id=replacement_id then replacement_id else null end,'schedule_version',f.schedule_version+1)
    from public.follow_ups f where f.tenant_id=p_tenant and f.lead_id=lead_record.id and f.state='OPEN' and f.assignee_id=p_member;
   update public.follow_ups set assignee_id=case when replacement.role in ('OWNER','ADMIN') or lead_record.assignee_id=replacement_id then replacement_id else null end,version=version+1,schedule_version=schedule_version+1 where tenant_id=p_tenant and lead_id=lead_record.id and state='OPEN' and assignee_id=p_member;
   update public.leads set version=version+1 where tenant_id=p_tenant and id=lead_record.id;
  end loop;
 end if;
 if not next_active or next_role='AGENT' then update public.invitations set state='REVOKED',version=version+1 where tenant_id=p_tenant and inviter_member_id=p_member and state='PENDING';end if;
 update public.memberships set role=next_role,active=next_active,deactivated_at=case when next_active then null else now() end,version=version+1 where tenant_id=p_tenant and id=p_member returning * into member;
 insert into public.activity_events(tenant_id,actor_id,event_type,reason,request_id,details) values(p_tenant,auth.uid(),'MEMBER_CHANGED',trim(p_payload->>'reason'),p_request_id,jsonb_build_object('member_id',member.id,'role',member.role,'active',member.active,'affected_leads',lead_count,'affected_open_tasks',task_count));
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(p_tenant,'MEMBER_ACCESS_CHANGED',member.id,v_operation||':'||p_key::text,jsonb_build_object('active',member.active,'role',member.role));
 result:=jsonb_build_object('id',member.id,'role',member.role,'active',member.active,'version',member.version,'affected_leads',lead_count,'affected_open_tasks',task_count);
 insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create function public.transfer_agency_owner(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);target public.memberships;prior private.api_requests;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');v_operation text:='owner-transfer:'||p_tenant::text;result jsonb;target_id uuid;
begin
 perform private.team_payload(p_payload,array['expected_version','target_member_id','target_expected_version','confirmed','reason']);
 if p_key is null or p_request_id is null or p_payload->'confirmed' is distinct from 'true'::jsonb or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;
 perform private.require_recent_mfa();
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.response;end if;
 if member.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;
 if p_payload->>'expected_version' is distinct from member.version::text then raise exception 'VERSION_CONFLICT';end if;
 begin target_id:=(p_payload->>'target_member_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;
 select * into target from public.memberships m where m.tenant_id=p_tenant and m.id=target_id and m.active for update;
 if not found or target.id=member.id then raise exception 'VALIDATION_FAILED';end if;
 if p_payload->>'target_expected_version' is distinct from target.version::text then raise exception 'VERSION_CONFLICT';end if;
 update public.memberships set role='ADMIN',version=version+1 where tenant_id=p_tenant and id=member.id;
 update public.memberships set role='OWNER',version=version+1 where tenant_id=p_tenant and id=target.id;
 update public.invitations set state='REVOKED',version=version+1 where tenant_id=p_tenant and inviter_member_id=member.id and role='ADMIN' and state='PENDING';
 insert into public.activity_events(tenant_id,actor_id,event_type,reason,request_id,details) values(p_tenant,auth.uid(),'OWNER_TRANSFERRED',trim(p_payload->>'reason'),p_request_id,jsonb_build_object('previous_owner_member_id',member.id,'owner_member_id',target.id));
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(p_tenant,'MEMBER_ACCESS_CHANGED',target.id,v_operation||':'||p_key::text,jsonb_build_object('previous_owner_member_id',member.id));
 result:=jsonb_build_object('owner_member_id',target.id,'previous_owner_member_id',member.id);insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
revoke all on function public.team_snapshot(uuid),public.list_team_members(uuid,integer,timestamptz,uuid),public.list_team_invitations(uuid,integer,timestamptz,uuid),public.update_my_profile(uuid,jsonb,uuid,uuid),public.update_agency_settings(uuid,jsonb,uuid,uuid),public.create_team_invitation(uuid,jsonb,text,uuid,uuid),public.change_team_invitation(uuid,uuid,text,jsonb,text,uuid,uuid),public.accept_team_invitation(text,text,uuid,uuid),public.change_team_member(uuid,uuid,jsonb,uuid,uuid),public.transfer_agency_owner(uuid,jsonb,uuid,uuid) from public,anon;
grant execute on function public.team_snapshot(uuid),public.list_team_members(uuid,integer,timestamptz,uuid),public.list_team_invitations(uuid,integer,timestamptz,uuid),public.update_my_profile(uuid,jsonb,uuid,uuid),public.update_agency_settings(uuid,jsonb,uuid,uuid),public.create_team_invitation(uuid,jsonb,text,uuid,uuid),public.change_team_invitation(uuid,uuid,text,jsonb,text,uuid,uuid),public.accept_team_invitation(text,text,uuid,uuid),public.change_team_member(uuid,uuid,jsonb,uuid,uuid),public.transfer_agency_owner(uuid,jsonb,uuid,uuid) to authenticated;

-- Source: 202610060007_notifications.sql
-- Durable HTTP policy buckets. Separate DB writes also constrain successful direct business RPC commits.
create table private.request_limits(actor_id uuid not null references auth.users(id),kind text not null check(kind in ('HTTP_READ','HTTP_MUTATION','DB_MUTATION')),window_at timestamptz not null,count integer not null check(count>0),primary key(actor_id,kind,window_at));
revoke all on private.request_limits from public,anon,authenticated;
create function private.take_limit(p_actor uuid,p_kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare stamp timestamptz:=date_trunc('minute',now());used integer;cap integer;
begin
 cap:=case when p_kind='HTTP_READ' then 60 when p_kind in ('HTTP_MUTATION','DB_MUTATION') then 30 else null end;
 if cap is null or p_actor is null then raise exception 'VALIDATION_FAILED';end if;
 insert into private.request_limits values(p_actor,p_kind,stamp,1) on conflict(actor_id,kind,window_at) do update set count=least(request_limits.count+1,cap+1) returning count into used;
 return jsonb_build_object('allowed',used<=cap,'remaining',greatest(cap-used,0),'retry_after',greatest(1,ceil(extract(epoch from stamp+interval '1 minute'-now()))::integer));
end; $$;
create function public.consume_http_limit(p_kind text) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.verified_actor();
begin
 if p_kind not in ('read','mutation') or p_kind is null then raise exception 'VALIDATION_FAILED';end if;
 return private.take_limit(actor,case when p_kind='read' then 'HTTP_READ' else 'HTTP_MUTATION' end);
end; $$;
create function private.enforce_write_limit(p_actor uuid) returns void language plpgsql security definer set search_path='' as $$
begin if (private.take_limit(p_actor,'DB_MUTATION')->>'allowed')::boolean is not true then raise exception 'RATE_LIMITED';end if;end; $$;
create or replace function private.writer_member(p_tenant uuid) returns public.memberships language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.verified_actor();result public.memberships;
begin
 perform private.enforce_write_limit(actor);
 if not exists(select 1 from public.memberships m where m.tenant_id=p_tenant and m.user_id=actor and m.active) then raise exception 'MEMBERSHIP_REQUIRED';end if;
 perform 1 from public.agencies a where a.id=p_tenant for update;result:=private.active_member(p_tenant);return result;
end; $$;
revoke all on function private.take_limit(uuid,text),private.enforce_write_limit(uuid),public.consume_http_limit(text) from public,anon,authenticated;
grant execute on function public.consume_http_limit(text) to authenticated;

alter table public.leads add column assignment_version integer not null default 1 check(assignment_version>0),add column review_version integer not null default 1 check(review_version>0);
alter table private.outbox_events add column attempts integer not null default 0 check(attempts between 0 and 3),add column available_at timestamptz not null default now(),add column lease_token uuid,add column lease_until timestamptz,add column completed_at timestamptz,add column last_error_code text,add column recipient_cursor uuid,add column emitted_count integer not null default 0;
alter table private.outbox_events add constraint outbox_state check(state in ('PENDING','RUNNING','SUCCEEDED','CANCELLED','FAILED'));
alter table private.outbox_events add constraint outbox_lease check((state='RUNNING' and lease_token is not null and lease_until is not null) or (state<>'RUNNING' and lease_token is null and lease_until is null));
create index outbox_claim on private.outbox_events(state,available_at,lease_until,created_at,id);
create index follow_up_global_due on public.follow_ups(due_at,id) where state='OPEN';
create table public.notifications(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),recipient_id uuid not null,type text not null check(type in ('LEAD_ASSIGNED','FOLLOW_UP_DUE','AI_READY','AI_FAILED','INVITE_ACCEPTED','MANAGER_REVIEW')),resource_id uuid not null,lead_id uuid,task_id uuid,schedule_version integer,assignment_version integer,review_version integer,dedupe_key text not null,created_at timestamptz not null default now(),read_at timestamptz,dismissed_at timestamptz,version integer not null default 1 check(version>0),
 foreign key(tenant_id,recipient_id) references public.memberships(tenant_id,id),foreign key(tenant_id,lead_id) references public.leads(tenant_id,id),foreign key(tenant_id,task_id) references public.follow_ups(tenant_id,id),unique(tenant_id,recipient_id,dedupe_key));
create index notification_inbox on public.notifications(tenant_id,recipient_id,created_at desc,id desc);
alter table public.notifications enable row level security;
create policy notification_recipient on public.notifications for select to authenticated using(exists(select 1 from public.memberships m where m.tenant_id=notifications.tenant_id and m.id=notifications.recipient_id and m.user_id=auth.uid() and m.active));
revoke all on public.notifications from public,anon,authenticated;grant select on public.notifications to authenticated;

create function private.capture_notification_event() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if TG_OP='INSERT' or new.assignee_id is distinct from old.assignee_id then
  insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(new.tenant_id,'LEAD_ASSIGNED',new.id,'assignment:'||new.id::text||':'||new.assignment_version::text,jsonb_build_object('assignee_id',new.assignee_id,'assignment_version',new.assignment_version)) on conflict(tenant_id,dedupe_key) do nothing;
 end if;
 if new.duplicate_review and (TG_OP='INSERT' or not old.duplicate_review) then
  insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(new.tenant_id,'MANAGER_REVIEW',new.id,'review:'||new.id::text||':'||new.review_version::text,jsonb_build_object('review_version',new.review_version)) on conflict(tenant_id,dedupe_key) do nothing;
 end if;return new;
end; $$;
create function private.bump_notice_versions() returns trigger language plpgsql set search_path='' as $$
begin
 new.assignment_version:=old.assignment_version+case when new.assignee_id is distinct from old.assignee_id then 1 else 0 end;
 new.review_version:=old.review_version+case when new.duplicate_review is distinct from old.duplicate_review then 1 else 0 end;return new;
end; $$;
create trigger lead_notice_versions before update on public.leads for each row execute function private.bump_notice_versions();
create trigger lead_notice_event after insert or update on public.leads for each row execute function private.capture_notification_event();
revoke all on function private.capture_notification_event(),private.bump_notice_versions() from public,anon,authenticated;

create function private.recipient_access(p_tenant uuid,p_recipient uuid,p_lead uuid,p_task uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.tenant_id=p_tenant and m.id=p_recipient and m.active and exists(select 1 from auth.users u where u.id=m.user_id and u.email_confirmed_at is not null)
 and (p_lead is null or exists(select 1 from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)))
 and (p_task is null or exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant and f.id=p_task and f.lead_id=p_lead and (m.role in ('OWNER','ADMIN') or f.assignee_id=m.id))));
$$;
create function private.notice_current(n public.notifications) returns boolean language plpgsql stable security definer set search_path='' as $$
declare member public.memberships;lead public.leads;task public.follow_ups;
begin
 if not private.recipient_access(n.tenant_id,n.recipient_id,n.lead_id,n.task_id) then return false;end if;
 select * into member from public.memberships where tenant_id=n.tenant_id and id=n.recipient_id and active;
 if n.type='INVITE_ACCEPTED' then return member.role in ('OWNER','ADMIN') and exists(select 1 from public.memberships m where m.tenant_id=n.tenant_id and m.id=n.resource_id and m.active and (member.role='OWNER' or m.role='AGENT'));end if;
 if n.lead_id is null then return false;end if;
 select * into lead from public.leads where tenant_id=n.tenant_id and id=n.lead_id;
 if not found or lead.archived_at is not null or lead.status in ('WON','LOST') then return false;end if;
 if n.type='LEAD_ASSIGNED' then return lead.assignment_version=n.assignment_version and (lead.assignee_id=n.recipient_id or lead.assignee_id is null and member.role in ('OWNER','ADMIN'));end if;
 if n.type='MANAGER_REVIEW' then return lead.duplicate_review and lead.review_version=n.review_version and member.role in ('OWNER','ADMIN');end if;
 if n.type='FOLLOW_UP_DUE' then
  select * into task from public.follow_ups where tenant_id=n.tenant_id and id=n.task_id and lead_id=n.lead_id;
  return found and task.state='OPEN' and task.schedule_version=n.schedule_version and task.due_at<=now() and (not lead.do_not_contact or task.type='INTERNAL') and (task.assignee_id=n.recipient_id or task.assignee_id is null and member.role in ('OWNER','ADMIN'));
 end if;
 -- AI producers and context-version checks arrive with P5; no invented AI notices.
 return false;
end; $$;
revoke all on function private.recipient_access(uuid,uuid,uuid,uuid),private.notice_current(public.notifications) from public,anon,authenticated;

create view private.due_candidates as
select f.tenant_id,f.id as task_id,f.lead_id,f.schedule_version,f.due_at,m.id as recipient_id,'due:'||f.id::text||':'||f.schedule_version::text||':'||m.id::text as job_key,'due:'||f.id::text||':'||f.schedule_version::text as notice_key
from public.follow_ups f join public.leads l on l.tenant_id=f.tenant_id and l.id=f.lead_id join public.memberships m on m.tenant_id=f.tenant_id and m.active
where f.state='OPEN' and f.due_at<=now() and l.archived_at is null and l.status not in ('WON','LOST') and (not l.do_not_contact or f.type='INTERNAL')
and (f.assignee_id=m.id or f.assignee_id is null and m.role in ('OWNER','ADMIN')) and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
and exists(select 1 from auth.users u where u.id=m.user_id and u.email_confirmed_at is not null);
revoke all on private.due_candidates from public,anon,authenticated;
create function private.require_worker() returns void language plpgsql set search_path='' as $$
begin if current_setting('role',true) is distinct from 'service_role' then raise exception 'WORKER_REQUIRED';end if;end; $$;
revoke all on function private.require_worker() from public,anon,authenticated;

create function public.worker_seed_due(p_limit integer default 100) returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;seeded integer:=0;
begin
 perform private.require_worker();if p_limit is null or p_limit not between 1 and 100 then raise exception 'VALIDATION_FAILED';end if;
 for candidate in select d.* from private.due_candidates d where not exists(select 1 from public.notifications n where n.tenant_id=d.tenant_id and n.recipient_id=d.recipient_id and n.dedupe_key=d.notice_key)
 and not exists(select 1 from private.outbox_events j where j.tenant_id=d.tenant_id and j.dedupe_key=d.job_key and j.state<>'CANCELLED') order by d.due_at,d.task_id,d.recipient_id limit p_limit loop
  insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(candidate.tenant_id,'FOLLOW_UP_DUE',candidate.task_id,candidate.job_key,jsonb_build_object('recipient_id',candidate.recipient_id,'lead_id',candidate.lead_id,'schedule_version',candidate.schedule_version))
  on conflict(tenant_id,dedupe_key) do update set state='PENDING',attempts=0,available_at=now(),lease_token=null,lease_until=null,completed_at=null,last_error_code=null where outbox_events.state='CANCELLED';
  if found then seeded:=seeded+1;end if;
 end loop;return jsonb_build_object('seeded',seeded);
end; $$;
create function public.worker_claim_notifications(p_limit integer default 20) returns table(id uuid,lease_token uuid,event_type text) language plpgsql security definer set search_path='' as $$
declare job private.outbox_events;token uuid;
begin
 perform private.require_worker();if p_limit is null or p_limit not between 1 and 20 then raise exception 'VALIDATION_FAILED';end if;
 for job in select j.* from private.outbox_events j where (j.state='PENDING' and j.available_at<=now() or j.state='RUNNING' and j.lease_until<=now()) order by j.available_at,j.created_at,j.id for update skip locked limit p_limit loop
  if job.attempts>=3 then update private.outbox_events j set state='FAILED',last_error_code='LEASE_EXHAUSTED',completed_at=now(),lease_token=null,lease_until=null where j.id=job.id;continue;end if;
  token:=gen_random_uuid();update private.outbox_events j set state='RUNNING',attempts=j.attempts+1,lease_token=token,lease_until=now()+interval '90 seconds',last_error_code=null where j.id=job.id;
  id:=job.id;lease_token:=token;event_type:=job.event_type;return next;
 end loop;
end; $$;
create function public.worker_finish_notification(p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.outbox_events;notice public.notifications;member public.memberships;lead public.leads;task public.follow_ups;recipients uuid[];recipient uuid;processed integer:=0;written integer:=0;row_count integer;done_state text;cursor_id uuid;
begin
 perform private.require_worker();
 select * into job from private.outbox_events where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 -- Same lock order as business writers; claims hold no agency lock.
 perform 1 from public.agencies where id=job.tenant_id for update;
 select * into job from private.outbox_events where id=p_job for update;
 if job.state<>'RUNNING' or job.lease_token is distinct from p_lease or job.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 notice.tenant_id:=job.tenant_id;notice.type:=job.event_type;notice.resource_id:=job.entity_id;
 if job.event_type in ('AGENCY_SETTINGS_CHANGED','MEMBER_ACCESS_CHANGED') then done_state:='SUCCEEDED';
 elsif job.event_type in ('LEAD_ASSIGNED','MANAGER_REVIEW') then
  select * into lead from public.leads where tenant_id=job.tenant_id and id=job.entity_id;
  notice.lead_id:=lead.id;notice.assignment_version:=(job.payload->>'assignment_version')::integer;notice.review_version:=(job.payload->>'review_version')::integer;
  -- Legacy assignment events without a captured version cannot safely describe the current assignment.
  notice.dedupe_key:=case when job.event_type='LEAD_ASSIGNED' then 'assignment:'||lead.id::text||':'||notice.assignment_version::text else 'review:'||lead.id::text||':'||notice.review_version::text end;
  select array_agg(m.id order by m.id) into recipients from (select m.* from public.memberships m where m.tenant_id=job.tenant_id and m.active and (job.recipient_cursor is null or m.id>job.recipient_cursor)
    and (job.event_type='LEAD_ASSIGNED' and (lead.assignee_id=m.id or lead.assignee_id is null and m.role in ('OWNER','ADMIN')) or job.event_type='MANAGER_REVIEW' and m.role in ('OWNER','ADMIN')) order by m.id limit 101) m;
 elsif job.event_type='FOLLOW_UP_DUE' then
  select * into task from public.follow_ups where tenant_id=job.tenant_id and id=job.entity_id;
  notice.task_id:=task.id;notice.lead_id:=task.lead_id;notice.schedule_version:=(job.payload->>'schedule_version')::integer;
  notice.dedupe_key:='due:'||task.id::text||':'||notice.schedule_version::text;recipients:=array[(job.payload->>'recipient_id')::uuid];
 elsif job.event_type='INVITE_ACCEPTED' then
  notice.resource_id:=(job.payload->>'member_id')::uuid;notice.dedupe_key:='invite:'||job.entity_id::text;recipients:=array[(job.payload->>'recipient_member_id')::uuid];
 else raise exception 'UNSUPPORTED_EVENT';end if;
 if recipients is not null then
  foreach recipient in array recipients loop
   exit when processed>=100;processed:=processed+1;cursor_id:=recipient;notice.recipient_id:=recipient;
   if notice.dedupe_key is not null and private.notice_current(notice) then
    insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,task_id,schedule_version,assignment_version,review_version,dedupe_key)
     values(notice.tenant_id,recipient,notice.type,notice.resource_id,notice.lead_id,notice.task_id,notice.schedule_version,notice.assignment_version,notice.review_version,notice.dedupe_key) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;
    get diagnostics row_count=row_count;written:=written+row_count;
   end if;
  end loop;
 end if;
 if coalesce(array_length(recipients,1),0)>100 then done_state:='PENDING';else done_state:=coalesce(done_state,case when job.emitted_count+written>0 or exists(select 1 from public.notifications n where n.tenant_id=job.tenant_id and n.dedupe_key=notice.dedupe_key and n.recipient_id=any(recipients)) then 'SUCCEEDED' else 'CANCELLED' end);end if;
 update private.outbox_events set state=done_state,lease_token=null,lease_until=null,completed_at=case when done_state='PENDING' then null else now() end,recipient_cursor=coalesce(cursor_id,recipient_cursor),emitted_count=emitted_count+written,attempts=case when done_state='PENDING' then 0 else attempts end,available_at=now() where id=job.id;
 return jsonb_build_object('state',done_state,'written',written);
end; $$;
create function public.worker_fail_notification(p_job uuid,p_lease uuid,p_code text default 'NOTIFICATION_WRITE_FAILED') returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.outbox_events;
begin
 perform private.require_worker();if p_code is null or p_code not in ('NOTIFICATION_WRITE_FAILED','UNSUPPORTED_EVENT','TRANSIENT_DATABASE_FAILURE','INVITATION_MAIL_FAILED') then raise exception 'VALIDATION_FAILED';end if;
 select * into job from private.outbox_events where id=p_job for update;
 if not found or job.state<>'RUNNING' or job.lease_token is distinct from p_lease or job.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update private.outbox_events set state=case when attempts>=3 then 'FAILED' else 'PENDING' end,last_error_code=p_code,available_at=now()+make_interval(secs=>30*power(2,attempts-1)::integer+floor(random()*11)::integer),completed_at=case when attempts>=3 then now() else null end,lease_token=null,lease_until=null where id=p_job returning * into job;
 return jsonb_build_object('state',job.state);
end; $$;
create function public.worker_requeue_notification(p_job uuid,p_expected_attempts integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.outbox_events;
begin
 perform private.require_worker();if p_expected_attempts is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select * into job from private.outbox_events where id=p_job;if not found then raise exception 'NOT_FOUND';end if;
 perform 1 from public.agencies where id=job.tenant_id for update;select * into job from private.outbox_events where id=p_job for update;
 if job.state<>'FAILED' or job.attempts<>p_expected_attempts then raise exception 'VERSION_CONFLICT';end if;
 update private.outbox_events set state='PENDING',attempts=0,available_at=now(),completed_at=null,lease_token=null,lease_until=null,last_error_code=null where id=p_job;
 insert into public.activity_events(tenant_id,event_type,request_id,details) values(job.tenant_id,'NOTIFICATION_JOB_REQUEUED',p_request_id,jsonb_build_object('job_id',job.id,'previous_attempts',job.attempts));
 return jsonb_build_object('state','PENDING');
end; $$;
create function public.worker_notification_metrics() returns jsonb language plpgsql security definer set search_path='' as $$
declare due_lag integer;outbox_lag integer;failed integer;pending integer;old_bucket record;cleaned integer:=0;
begin
 perform private.require_worker();
 select coalesce(greatest(0,extract(epoch from now()-min(d.due_at)))::integer,0) into due_lag from private.due_candidates d where not exists(select 1 from public.notifications n where n.tenant_id=d.tenant_id and n.recipient_id=d.recipient_id and n.dedupe_key=d.notice_key);
 select coalesce(greatest(0,extract(epoch from now()-min(created_at)))::integer,0),count(*)::integer into outbox_lag,pending from private.outbox_events where state in ('PENDING','RUNNING');
 select count(*)::integer into failed from private.outbox_events where state='FAILED';
 -- Policy windows have no business content. Retire at most 100 old rows each worker run.
 for old_bucket in select actor_id,kind,window_at from private.request_limits where window_at<now()-interval '2 hours' order by window_at for update skip locked limit 100 loop
  delete from private.request_limits where actor_id=old_bucket.actor_id and kind=old_bucket.kind and window_at=old_bucket.window_at;cleaned:=cleaned+1;
 end loop;
 return jsonb_build_object('due_lag_seconds',due_lag,'outbox_lag_seconds',outbox_lag,'pending_jobs',pending,'failed_jobs',failed,'alert',due_lag>900 or outbox_lag>900 or failed>0,'cleaned_limit_windows',cleaned);
end; $$;
revoke all on function public.worker_seed_due(integer),public.worker_claim_notifications(integer),public.worker_finish_notification(uuid,uuid),public.worker_fail_notification(uuid,uuid,text),public.worker_requeue_notification(uuid,integer,uuid),public.worker_notification_metrics() from public,anon,authenticated;
grant execute on function public.worker_seed_due(integer),public.worker_claim_notifications(integer),public.worker_finish_notification(uuid,uuid),public.worker_fail_notification(uuid,uuid,text),public.worker_requeue_notification(uuid,integer,uuid),public.worker_notification_metrics() to service_role;

create function public.list_notifications(p_tenant uuid,p_filter text default 'ALL',p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,type text,created_at timestamptz,read_at timestamptz,dismissed_at timestamptz,version integer,current boolean,can_open boolean,resource_label text,due_at timestamptz) language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);
begin
 if p_filter is null or p_filter not in ('ALL','UNREAD','DISMISSED') or p_limit is null or p_limit not between 1 and 101 then raise exception 'VALIDATION_FAILED';end if;
 return query select n.id,n.type,n.created_at,n.read_at,n.dismissed_at,n.version,private.notice_current(n),
 private.recipient_access(n.tenant_id,n.recipient_id,n.lead_id,n.task_id) and (n.lead_id is not null or private.notice_current(n)),
 case when private.notice_current(n) then l.full_name else null end,case when private.notice_current(n) then f.due_at else null end
 from public.notifications n left join public.leads l on l.tenant_id=n.tenant_id and l.id=n.lead_id left join public.follow_ups f on f.tenant_id=n.tenant_id and f.id=n.task_id
 where n.tenant_id=p_tenant and n.recipient_id=member.id and (p_filter='ALL' and n.dismissed_at is null or p_filter='UNREAD' and n.dismissed_at is null and n.read_at is null or p_filter='DISMISSED' and n.dismissed_at is not null)
 and (p_cursor_time is null or (n.created_at,n.id)<(p_cursor_time,p_cursor_id)) order by n.created_at desc,n.id desc limit p_limit;
end; $$;
create function public.notification_summary(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);count_value integer;
begin select count(*)::integer into count_value from public.notifications where tenant_id=p_tenant and recipient_id=member.id and read_at is null and dismissed_at is null;return jsonb_build_object('unread_count',count_value);end; $$;
create function public.update_notification(p_tenant uuid,p_notification uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);notice public.notifications;prior private.api_requests;v_operation text:='notice:'||p_tenant::text||':'||p_notification::text;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');result jsonb;
begin
 perform private.team_payload(p_payload,array['expected_version','read','dismiss']);
 if p_key is null or p_request_id is null or (p_payload->'read' is distinct from 'true'::jsonb and p_payload->'dismiss' is distinct from 'true'::jsonb) or (p_payload ? 'read' and p_payload->'read' is distinct from 'true'::jsonb) or (p_payload ? 'dismiss' and p_payload->'dismiss' is distinct from 'true'::jsonb) then raise exception 'VALIDATION_FAILED';end if;
 select * into notice from public.notifications where tenant_id=p_tenant and id=p_notification and recipient_id=member.id for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.response;end if;
 if p_payload->>'expected_version' is distinct from notice.version::text then raise exception 'VERSION_CONFLICT';end if;
 update public.notifications set read_at=case when p_payload->'read'='true'::jsonb then coalesce(read_at,now()) else read_at end,dismissed_at=case when p_payload->'dismiss'='true'::jsonb then coalesce(dismissed_at,now()) else dismissed_at end,version=version+1 where id=notice.id returning * into notice;
 result:=jsonb_build_object('id',notice.id,'version',notice.version,'read_at',notice.read_at,'dismissed_at',notice.dismissed_at);insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create function public.open_notification(p_tenant uuid,p_notification uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);notice public.notifications;
begin
 select * into notice from public.notifications where tenant_id=p_tenant and id=p_notification and recipient_id=member.id;if not found then raise exception 'NOT_FOUND';end if;
 if not private.recipient_access(notice.tenant_id,notice.recipient_id,notice.lead_id,notice.task_id) then return jsonb_build_object('available',false);end if;
 if notice.lead_id is not null then return jsonb_build_object('available',true,'kind','lead','lead_id',notice.lead_id,'task_id',notice.task_id);end if;
 if notice.type='INVITE_ACCEPTED' and private.notice_current(notice) then return jsonb_build_object('available',true,'kind','team');end if;
 return jsonb_build_object('available',false);
end; $$;
revoke all on function public.list_notifications(uuid,text,integer,timestamptz,uuid),public.notification_summary(uuid),public.update_notification(uuid,uuid,jsonb,uuid,uuid),public.open_notification(uuid,uuid) from public,anon;
grant execute on function public.list_notifications(uuid,text,integer,timestamptz,uuid),public.notification_summary(uuid),public.update_notification(uuid,uuid,jsonb,uuid,uuid),public.open_notification(uuid,uuid) to authenticated;
create or replace function public.create_agency(p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.verified_actor(); agency public.agencies; member public.memberships;
 prior private.api_requests; payload_hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex'); result jsonb;
begin
 perform private.enforce_write_limit(actor);
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('name','timezone','locale'))
 or jsonb_typeof(p_payload->'name') is distinct from 'string' or char_length(trim(p_payload->>'name')) not between 2 and 120
 or coalesce(p_payload->>'locale','en')<>'en' or not exists(select 1 from pg_catalog.pg_timezone_names where name=coalesce(p_payload->>'timezone','Asia/Dubai')) then raise exception 'VALIDATION_FAILED'; end if;
 perform pg_advisory_xact_lock(hashtextextended(actor::text||'agency'||p_key::text,0));
 select * into prior from private.api_requests where actor_id=actor and operation='agency' and request_key=p_key;
 if found then
  perform private.active_member(prior.tenant_id);
  if prior.payload_hash<>payload_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
  return prior.response;
 end if;
 insert into public.agencies(name,timezone,locale) values(trim(p_payload->>'name'),coalesce(p_payload->>'timezone','Asia/Dubai'),'en') returning * into agency;
 insert into public.memberships(tenant_id,user_id,role) values(agency.id,actor,'OWNER') returning * into member;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id) values(agency.id,actor,'AGENCY_CREATED',p_request_id);
 result:=jsonb_build_object('agency',to_jsonb(agency),'membership',to_jsonb(member));
 insert into private.api_requests values(actor,'agency',p_key,payload_hash,agency.id,result,now());
 return result;
end; $$;
create or replace function public.accept_team_invitation(p_token_hash text,p_display_name text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=private.verified_actor();invite public.invitations;inviter public.memberships;member public.memberships;prior private.api_requests;email text;cap integer;v_operation text;hash text;result jsonb;
begin
 perform private.enforce_write_limit(actor);
 if p_key is null or p_request_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or p_display_name is null or char_length(trim(p_display_name)) not between 2 and 120 then raise exception 'INVITATION_UNAVAILABLE';end if;
 select * into invite from public.invitations where token_hash=p_token_hash;if not found then raise exception 'INVITATION_UNAVAILABLE';end if;
 perform 1 from public.agencies where id=invite.tenant_id for update;
 select * into invite from public.invitations where token_hash=p_token_hash for update;if not found then raise exception 'INVITATION_UNAVAILABLE';end if;
 select lower(trim(u.email)) into email from auth.users u where u.id=actor;
 if email is distinct from invite.email then raise exception 'INVITATION_UNAVAILABLE';end if;
 v_operation:='invite-accept:'||invite.id::text;hash:=encode(sha256(convert_to(jsonb_build_array(p_token_hash,trim(p_display_name))::text,'UTF8')),'hex');
 select * into prior from private.api_requests r where r.actor_id=actor and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if invite.consumed_by is distinct from actor or not exists(select 1 from public.memberships m where m.tenant_id=invite.tenant_id and m.user_id=actor and m.active) then raise exception 'INVITATION_UNAVAILABLE';end if;return prior.response;
 end if;
 if invite.state<>'PENDING' or invite.expires_at<=now() then raise exception 'INVITATION_UNAVAILABLE';end if;
 select * into inviter from public.memberships m where m.tenant_id=invite.tenant_id and m.id=invite.inviter_member_id and m.active;
 if not found or (inviter.role<>'OWNER' and (inviter.role<>'ADMIN' or invite.role<>'AGENT')) then raise exception 'INVITATION_UNAVAILABLE';end if;
 if exists(select 1 from public.memberships m where m.tenant_id=invite.tenant_id and m.user_id=actor) then raise exception 'INVITATION_UNAVAILABLE';end if;
 if invite.role='ADMIN' then perform private.require_recent_mfa();end if;
 select a.seat_limit into cap from public.agencies a where a.id=invite.tenant_id;if cap is null then raise exception 'SEAT_LIMIT_REQUIRED';end if;
 if private.seat_count(invite.tenant_id)>cap then raise exception 'SEAT_LIMIT_REACHED';end if;
 insert into public.memberships(tenant_id,user_id,role,display_name) values(invite.tenant_id,actor,invite.role,trim(p_display_name)) returning * into member;
 update public.invitations set state='CONSUMED',consumed_by=actor,version=version+1 where id=invite.id;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(invite.tenant_id,actor,'INVITATION_ACCEPTED',p_request_id,jsonb_build_object('invitation_id',invite.id,'member_id',member.id,'role',member.role));
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(invite.tenant_id,'INVITE_ACCEPTED',invite.id,v_operation,jsonb_build_object('recipient_member_id',inviter.id,'member_id',member.id));
 result:=jsonb_build_object('tenant_id',invite.tenant_id,'membership',jsonb_build_object('id',member.id,'role',member.role,'display_name',member.display_name));
 insert into private.api_requests values(actor,v_operation,p_key,hash,invite.tenant_id,result,now());return result;
end; $$;

create function private.enqueue_invitation_mail(p_tenant uuid,p_invite uuid,p_actor uuid,p_scope text,p_key uuid,p_hash text) returns void language sql security definer set search_path='' as $$
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(p_tenant,'INVITATION_MAIL',p_invite,'mail:'||p_actor::text||':'||p_scope||':'||p_invite::text||':'||p_key::text,jsonb_build_object('actor_id',p_actor,'token_operation',p_scope,'request_key',p_key,'token_hash',p_hash)) on conflict(tenant_id,dedupe_key) do nothing;
$$;
revoke all on function private.enqueue_invitation_mail(uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated;
create function public.worker_prepare_invitation_mail(p_job uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.outbox_events;invite public.invitations;member public.memberships;
begin
 perform private.require_worker();select * into job from private.outbox_events where id=p_job;
 if not found or job.event_type<>'INVITATION_MAIL' or job.state<>'RUNNING' or job.lease_token is distinct from p_lease or job.lease_until<=now() then return jsonb_build_object('available',false);end if;
 select * into invite from public.invitations where tenant_id=job.tenant_id and id=job.entity_id and state='PENDING' and expires_at>now() and token_hash=job.payload->>'token_hash';
 if not found then return jsonb_build_object('available',false);end if;
 select * into member from public.memberships where tenant_id=job.tenant_id and id=invite.inviter_member_id and user_id=(job.payload->>'actor_id')::uuid and active;
 if not found or member.role not in ('OWNER','ADMIN') or (member.role='ADMIN' and invite.role<>'AGENT') or not exists(select 1 from auth.users u where u.id=member.user_id and u.email_confirmed_at is not null) then return jsonb_build_object('available',false);end if;
 return jsonb_build_object('available',true,'to',invite.email,'tenant_id',job.tenant_id,'actor_id',member.user_id,'token_operation',job.payload->>'token_operation','request_key',job.payload->>'request_key','token_hash',invite.token_hash);
end; $$;
create function public.worker_complete_invitation_mail(p_job uuid,p_lease uuid,p_result text) returns jsonb language plpgsql security definer set search_path='' as $$
declare job private.outbox_events;done_state text;
begin
 perform private.require_worker();if p_result is null or p_result not in ('EMAIL_ACCEPTED','LINK_ONLY','TOKEN_ROTATED','INVITATION_UNAVAILABLE') then raise exception 'VALIDATION_FAILED';end if;
 select * into job from private.outbox_events where id=p_job for update;
 if not found or job.event_type<>'INVITATION_MAIL' or job.state<>'RUNNING' or job.lease_token is distinct from p_lease or job.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 done_state:=case when p_result='EMAIL_ACCEPTED' then 'SUCCEEDED' else 'CANCELLED' end;
 update private.outbox_events set state=done_state,completed_at=now(),lease_token=null,lease_until=null,last_error_code=case when done_state='CANCELLED' then p_result else null end where id=p_job;
 return jsonb_build_object('state',done_state,'written',0);
end; $$;
create function public.invitation_delivery_state(p_tenant uuid,p_invite uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);invite public.invitations;job private.outbox_events;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 select * into invite from public.invitations where tenant_id=p_tenant and id=p_invite and (member.role='OWNER' or role='AGENT');if not found then raise exception 'NOT_FOUND';end if;
 select * into job from private.outbox_events where tenant_id=p_tenant and entity_id=p_invite and event_type='INVITATION_MAIL' and payload->>'request_key'=p_key::text and payload->>'actor_id'=auth.uid()::text and payload->>'token_hash'=invite.token_hash order by created_at desc,id desc limit 1;
 return jsonb_build_object('state',coalesce(job.state,'UNAVAILABLE'));
end; $$;
revoke all on function public.worker_prepare_invitation_mail(uuid,uuid),public.worker_complete_invitation_mail(uuid,uuid,text),public.invitation_delivery_state(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.worker_prepare_invitation_mail(uuid,uuid),public.worker_complete_invitation_mail(uuid,uuid,text) to service_role;
grant execute on function public.invitation_delivery_state(uuid,uuid,uuid) to authenticated;

create or replace function public.create_team_invitation(p_tenant uuid,p_payload jsonb,p_token_hash text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);invite public.invitations;prior private.api_requests;hash text:=encode(sha256(convert_to(jsonb_build_array(p_payload,p_token_hash)::text,'UTF8')),'hex');v_operation text:='invite:'||p_tenant::text;result jsonb;cap integer;v_email text;invite_role public.member_role;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['email','role']);
 if p_key is null or p_request_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' or jsonb_typeof(p_payload->'email') is distinct from 'string' or char_length(p_payload->>'email')>254
 or p_payload->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or coalesce(p_payload->>'role','') not in ('ADMIN','AGENT') then raise exception 'VALIDATION_FAILED';end if;
 v_email:=lower(trim(p_payload->>'email'));invite_role:=(p_payload->>'role')::public.member_role;
 if invite_role='ADMIN' then if member.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;perform private.require_recent_mfa();end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  select * into invite from public.invitations where id=(prior.response->>'id')::uuid and tenant_id=p_tenant;
  if invite.state<>'PENDING' or invite.expires_at<=now() or invite.token_hash<>p_token_hash then raise exception 'INVITATION_UNAVAILABLE';end if;perform private.enqueue_invitation_mail(p_tenant,invite.id,auth.uid(),'create:',p_key,p_token_hash);return prior.response;
 end if;
 if exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and lower(trim(u.email))=v_email) then raise exception 'MEMBER_EXISTS';end if;
 if exists(select 1 from public.invitations i where i.tenant_id=p_tenant and i.email=v_email and i.state='PENDING' and i.expires_at>now()) then raise exception 'INVITATION_EXISTS';end if;
 select a.seat_limit into cap from public.agencies a where a.id=p_tenant;if cap is null then raise exception 'SEAT_LIMIT_REQUIRED';end if;
 if private.seat_count(p_tenant)>=cap then raise exception 'SEAT_LIMIT_REACHED';end if;
 insert into public.invitations(tenant_id,email,role,token_hash,created_by,inviter_member_id) values(p_tenant,v_email,invite_role,p_token_hash,auth.uid(),member.id) returning * into invite;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'INVITATION_CREATED',p_request_id,jsonb_build_object('invitation_id',invite.id,'role',invite.role));
 perform private.enqueue_invitation_mail(p_tenant,invite.id,auth.uid(),'create:',p_key,p_token_hash);
 result:=to_jsonb(invite)-'token_hash'-'consumed_by';insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create or replace function public.change_team_invitation(p_tenant uuid,p_invite uuid,p_action text,p_payload jsonb,p_token_hash text,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);invite public.invitations;prior private.api_requests;hash text:=encode(sha256(convert_to(jsonb_build_array(p_payload,p_token_hash)::text,'UTF8')),'hex');v_operation text:='invite-action:'||p_tenant::text||':'||p_invite::text||':'||p_action;result jsonb;cap integer;reserved boolean;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['expected_version']);
 if p_action is null or p_action not in ('resend','revoke') or p_key is null or p_request_id is null or (p_action='resend' and (p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$')) or (p_action='revoke' and p_token_hash is not null) then raise exception 'VALIDATION_FAILED';end if;
 select * into invite from public.invitations where tenant_id=p_tenant and id=p_invite for update;if not found then raise exception 'NOT_FOUND';end if;
 if invite.role='ADMIN' and member.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;
 if p_action='resend' and invite.role='ADMIN' then perform private.require_recent_mfa();end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if p_action='resend' and (invite.state<>'PENDING' or invite.expires_at<=now() or invite.token_hash<>p_token_hash) then raise exception 'INVITATION_UNAVAILABLE';end if;if p_action='resend' then perform private.enqueue_invitation_mail(p_tenant,invite.id,auth.uid(),'resend:'||invite.id::text,p_key,p_token_hash);end if;return prior.response;
 end if;
 if p_payload->>'expected_version' is distinct from invite.version::text then raise exception 'VERSION_CONFLICT';end if;
 if invite.state<>'PENDING' then raise exception 'INVITATION_UNAVAILABLE';end if;
 if p_action='resend' then
  select a.seat_limit into cap from public.agencies a where a.id=p_tenant;if cap is null then raise exception 'SEAT_LIMIT_REQUIRED';end if;
  reserved:=invite.expires_at>now();if private.seat_count(p_tenant)-(case when reserved then 1 else 0 end)>=cap then raise exception 'SEAT_LIMIT_REACHED';end if;
  update public.invitations set token_hash=p_token_hash,expires_at=now()+interval '72 hours',version=version+1,created_by=auth.uid(),inviter_member_id=member.id where id=p_invite returning * into invite;
 else update public.invitations set state='REVOKED',version=version+1 where id=p_invite returning * into invite;end if;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'INVITATION_'||upper(p_action),p_request_id,jsonb_build_object('invitation_id',invite.id));
 if p_action='resend' then perform private.enqueue_invitation_mail(p_tenant,invite.id,auth.uid(),'resend:'||invite.id::text,p_key,p_token_hash);end if;
 result:=to_jsonb(invite)-'token_hash'-'consumed_by';insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
drop function public.list_team_invitations(uuid,integer,timestamptz,uuid);
create function public.list_team_invitations(p_tenant uuid,p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,email text,role public.member_role,state text,expires_at timestamptz,version integer,created_at timestamptz,delivery_state text)
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 return query select i.id,i.email,i.role,case when i.state='PENDING' and i.expires_at<=now() then 'EXPIRED' else i.state end,i.expires_at,i.version,i.created_at,coalesce((select case when j.state='SUCCEEDED' then 'EMAIL_ACCEPTED' when j.state='FAILED' then 'EMAIL_FAILED' when j.state='CANCELLED' and j.last_error_code='LINK_ONLY' then 'LINK_ONLY' when j.state='CANCELLED' then 'EMAIL_UNAVAILABLE' else 'EMAIL_QUEUED' end from private.outbox_events j where j.tenant_id=i.tenant_id and j.entity_id=i.id and j.event_type='INVITATION_MAIL' and j.payload->>'token_hash'=i.token_hash order by j.created_at desc,j.id desc limit 1),'LINK_ONLY')
 from public.invitations i where i.tenant_id=p_tenant and (member.role='OWNER' or i.role='AGENT')
 and (p_cursor_time is null or (i.created_at,i.id)>(p_cursor_time,p_cursor_id)) order by i.created_at,i.id limit least(greatest(p_limit,1),101);
end; $$;
revoke all on function public.list_team_invitations(uuid,integer,timestamptz,uuid) from public,anon;
grant execute on function public.list_team_invitations(uuid,integer,timestamptz,uuid) to authenticated;

-- Source: 202610060008_capture.sql
alter table public.leads add column budget_period text not null default 'UNKNOWN' check(budget_period in ('MONTH','YEAR','TOTAL','UNKNOWN')),
 add column property_type text check(char_length(property_type)<=120),add column bedrooms integer check(bedrooms between 0 and 50),
 add column purchase_timeline text check(char_length(purchase_timeline)<=500),add column source_reference text check(char_length(source_reference)<=500),
 add column notes text not null default '' check(char_length(notes)<=2000),add column reported_facts jsonb not null default '{}' check(jsonb_typeof(reported_facts)='object');
alter table public.messages add constraint message_parent_unique unique(tenant_id,lead_id,id);
alter table public.messages add column version integer not null default 1 check(version>0),add column source_reference text,add column ingested_at timestamptz;
create table public.message_revisions(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,message_id uuid not null,
 previous_body text not null,revision integer not null,reason text not null check(char_length(trim(reason)) between 5 and 500),actor_id uuid not null references auth.users(id),created_at timestamptz not null default now(),
 foreign key(tenant_id,lead_id) references public.leads(tenant_id,id),foreign key(tenant_id,lead_id,message_id) references public.messages(tenant_id,lead_id,id),unique(tenant_id,message_id,revision));
alter table public.message_revisions enable row level security;
create policy revision_read on public.message_revisions for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=message_revisions.tenant_id and l.id=message_revisions.lead_id));
revoke all on public.message_revisions from public,anon,authenticated;grant select on public.message_revisions to authenticated;
create index message_revision_history on public.message_revisions(tenant_id,message_id,revision desc);

alter function private.validate_lead(jsonb) rename to validate_lead_core;
create function private.validate_facts(p jsonb) returns void language plpgsql set search_path='' as $$
declare v jsonb;k text;
begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'confirmed_intent' and p->'confirmed_intent'<>'null'::jsonb and (jsonb_typeof(p->'confirmed_intent')<>'string' or p->>'confirmed_intent' not in ('BUY','RENT','SELL','INVEST','OTHER')) then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'budget_period' and (jsonb_typeof(p->'budget_period') is distinct from 'string' or p->>'budget_period' not in ('MONTH','YEAR','TOTAL','UNKNOWN')) then raise exception 'VALIDATION_FAILED';end if;
 foreach k in array array['property_type','purchase_timeline','source_reference','notes'] loop
  if p ? k and p->k<>'null'::jsonb and (jsonb_typeof(p->k)<>'string' or char_length(p->>k)>case k when 'property_type' then 120 when 'notes' then 2000 else 500 end) then raise exception 'VALIDATION_FAILED';end if;
 end loop;
 if p ? 'notes' and p->'notes'='null'::jsonb then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'bedrooms' and p->'bedrooms'<>'null'::jsonb and (jsonb_typeof(p->'bedrooms')<>'number' or p->>'bedrooms' !~ '^[0-9]+$' or (p->>'bedrooms')::numeric not between 0 and 50) then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'locations' then
  if jsonb_typeof(p->'locations') is distinct from 'array' or jsonb_array_length(p->'locations')>5 then raise exception 'VALIDATION_FAILED';end if;
  for v in select value from jsonb_array_elements(p->'locations') loop
   if jsonb_typeof(v)<>'string' or char_length(trim(v#>>'{}')) not between 1 and 120 then raise exception 'VALIDATION_FAILED';end if;
  end loop;
 end if;
end;$$;
create function private.validate_lead(p_payload jsonb) returns void language plpgsql set search_path='' as $$
begin
 perform private.validate_lead_core(p_payload-array['confirmed_intent','budget_period','locations','property_type','bedrooms','purchase_timeline','source_reference','notes']);
 perform private.validate_facts(p_payload);
end;$$;
create function private.manager_writer(p_tenant uuid) returns public.memberships language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);begin if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;return m;end;$$;
create function private.insert_capture(p_tenant uuid,p_payload jsonb,p_assignee uuid,p_source text,p_actor uuid,p_request uuid,p_occurred timestamptz default null) returns public.leads
language plpgsql security definer set search_path='' as $$
declare l public.leads;dupe boolean;human boolean:=p_source<>'WEBSITE';
begin
 perform private.validate_lead(p_payload);
 if p_source not in ('MANUAL','CSV','WEBSITE') or p_actor is null or p_request is null or p_occurred>now() or (p_occurred is not null and not isfinite(p_occurred)) then raise exception 'VALIDATION_FAILED';end if;
 if p_assignee is not null and not exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and m.id=p_assignee and m.active and u.email_confirmed_at is not null) then raise exception 'VALIDATION_FAILED';end if;
 select exists(select 1 from public.leads x where x.tenant_id=p_tenant and ((coalesce(p_payload->>'email','')<>'' and lower(trim(x.email))=lower(trim(p_payload->>'email'))) or (coalesce(p_payload->>'phone','')<>'' and x.phone=p_payload->>'phone'))) into dupe;
 insert into public.leads(tenant_id,assignee_id,full_name,email,phone,source,created_by,budget_min,budget_max,currency,duplicate_review,confirmed_intent,budget_period,locations,property_type,bedrooms,purchase_timeline,source_reference,notes,reported_facts)
 values(p_tenant,p_assignee,trim(p_payload->>'full_name'),nullif(lower(trim(p_payload->>'email')),''),nullif(p_payload->>'phone',''),p_source,p_actor,
 case when human then (p_payload->>'budget_min')::numeric end,case when human then (p_payload->>'budget_max')::numeric end,case when human then p_payload->>'currency' end,dupe,
 case when human then p_payload->>'confirmed_intent' end,case when human then coalesce(p_payload->>'budget_period','UNKNOWN') else 'UNKNOWN' end,
 case when human then array(select distinct trim(value) from jsonb_array_elements_text(coalesce(p_payload->'locations','[]')) as v(value)) else '{}'::text[] end,
 case when human then nullif(trim(p_payload->>'property_type'),'') end,case when human then (p_payload->>'bedrooms')::integer end,case when human then nullif(trim(p_payload->>'purchase_timeline'),'') end,
 nullif(trim(p_payload->>'source_reference'),''),case when human then coalesce(p_payload->>'notes','') else '' end,
 case when human then '{}'::jsonb else p_payload-array['full_name','email','phone','initial_message','source_reference','notes','assignee_id'] end) returning * into l;
 if coalesce(trim(p_payload->>'initial_message'),'')<>'' then
  insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at,author_id,source_reference,ingested_at)
  values(p_tenant,l.id,'INBOUND',case when p_source='WEBSITE' then 'WEBSITE' else 'MANUAL' end,trim(p_payload->>'initial_message'),coalesce(p_occurred,now()),p_actor,case when p_source='WEBSITE' then l.source_reference end,case when p_source='WEBSITE' then now() end);
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,l.id,p_actor,'LEAD_CREATED',p_request,jsonb_build_object('source',p_source));
 return l;
end;$$;
create or replace function public.create_lead(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);target uuid;l public.leads;r private.api_requests;op text:='lead:'||p_tenant;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 perform private.validate_lead(p_payload);if p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;
 if found then
  if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if not exists(select 1 from public.leads x where x.tenant_id=p_tenant and x.id=(r.response->>'id')::uuid and (m.role<>'AGENT' or x.assignee_id=m.id)) then raise exception 'NOT_FOUND';end if;return r.response;
 end if;
 if m.role='AGENT' then target:=m.id;if p_payload->>'assignee_id' is not null and p_payload->>'assignee_id'<>m.id::text then raise exception 'VALIDATION_FAILED';end if;
 else begin target:=(p_payload->>'assignee_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;end if;
 l:=private.insert_capture(p_tenant,p_payload,target,'MANUAL',m.user_id,p_request_id);
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,to_jsonb(l),now());return to_jsonb(l);
end;$$;
create function public.update_lead_facts(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;r private.api_requests;op text:='facts:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','confirmed_intent','budget_period','locations','property_type','bedrooms','purchase_timeline','source_reference','notes')) or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or not exists(select 1 from jsonb_object_keys(p_payload-'expected_version')) then raise exception 'VALIDATION_FAILED';end if;
 perform private.validate_facts(p_payload);
 select * into l from public.leads x where x.tenant_id=p_tenant and x.id=p_lead and (m.role<>'AGENT' or x.assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if p_payload->>'expected_version'<>l.version::text then raise exception 'VERSION_CONFLICT';end if;if l.archived_at is not null then raise exception 'CONTACT_BLOCKED';end if;
 if l.source='WEBSITE' and p_payload ? 'source_reference' and (p_payload->>'source_reference') is distinct from l.source_reference then raise exception 'PROVENANCE_IMMUTABLE';end if;
 update public.leads set confirmed_intent=case when p_payload ? 'confirmed_intent' then p_payload->>'confirmed_intent' else confirmed_intent end,
 budget_period=coalesce(p_payload->>'budget_period',budget_period),locations=case when p_payload ? 'locations' then array(select distinct trim(value) from jsonb_array_elements_text(p_payload->'locations') v(value)) else locations end,
 property_type=case when p_payload ? 'property_type' then nullif(trim(p_payload->>'property_type'),'') else property_type end,
 bedrooms=case when p_payload ? 'bedrooms' then (p_payload->>'bedrooms')::integer else bedrooms end,purchase_timeline=case when p_payload ? 'purchase_timeline' then nullif(trim(p_payload->>'purchase_timeline'),'') else purchase_timeline end,
 source_reference=case when p_payload ? 'source_reference' then nullif(trim(p_payload->>'source_reference'),'') else source_reference end,notes=coalesce(p_payload->>'notes',notes),version=version+1,context_version=context_version+1 where tenant_id=p_tenant and id=p_lead returning * into l;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,p_lead,m.user_id,'FACTS_CONFIRMED',p_request_id,jsonb_build_object('fields',array(select jsonb_object_keys(p_payload-'expected_version'))));
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,to_jsonb(l),now());return to_jsonb(l);
end;$$;
create function public.duplicate_candidates(p_tenant uuid,p_lead uuid,p_limit integer default 25,p_after uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);l public.leads;rows jsonb;
begin
 select * into l from public.leads x where x.tenant_id=p_tenant and x.id=p_lead and (m.role<>'AGENT' or x.assignee_id=m.id);if not found then raise exception 'NOT_FOUND';end if;
 if m.role='AGENT' then return jsonb_build_object('review_required',l.duplicate_review,'candidates','[]'::jsonb,'restricted',true);end if;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into rows from (select x.id,x.full_name,x.email,x.phone,x.status,x.archived_at from public.leads x where x.tenant_id=p_tenant and x.id<>p_lead and (p_after is null or x.id>p_after) and ((l.email is not null and lower(trim(x.email))=lower(trim(l.email))) or (l.phone is not null and x.phone=l.phone)) order by x.id limit least(greatest(p_limit,1),101)) c;
 return jsonb_build_object('review_required',l.duplicate_review,'candidates',rows,'restricted',false);
end;$$;
create function public.resolve_duplicate(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);l public.leads;r private.api_requests;op text:='duplicate:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','reason')) or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if p_payload->>'expected_version'<>l.version::text then raise exception 'VERSION_CONFLICT';end if;if not l.duplicate_review then raise exception 'STATE_CONFLICT';end if;
 update public.leads set duplicate_review=false,version=version+1 where tenant_id=p_tenant and id=p_lead returning * into l;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,p_lead,m.user_id,'DUPLICATE_RESOLVED_SEPARATE',p_request_id,trim(p_payload->>'reason'),'{}');
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,to_jsonb(l),now());return to_jsonb(l);
end;$$;
create function public.revise_message(p_tenant uuid,p_lead uuid,p_message uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;msg public.messages;r private.api_requests;op text:='revision:'||p_tenant||':'||p_message;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');result jsonb;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('body','reason','expected_version','expected_lead_version')) or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or jsonb_typeof(p_payload->'expected_lead_version') is distinct from 'number' or jsonb_typeof(p_payload->'body') is distinct from 'string' or char_length(trim(p_payload->>'body')) not between 1 and 10000 or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into msg from public.messages where tenant_id=p_tenant and lead_id=p_lead and id=p_message for update;if not found then raise exception 'NOT_FOUND';end if;
 if msg.channel<>'MANUAL' then raise exception 'PROVENANCE_IMMUTABLE';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if p_payload->>'expected_version'<>msg.version::text or p_payload->>'expected_lead_version'<>l.version::text then raise exception 'VERSION_CONFLICT';end if;
 if l.archived_at is not null then raise exception 'CONTACT_BLOCKED';end if;
 insert into public.message_revisions(tenant_id,lead_id,message_id,previous_body,revision,reason,actor_id) values(p_tenant,p_lead,p_message,msg.body,msg.version,trim(p_payload->>'reason'),m.user_id);
 update public.messages set body=trim(p_payload->>'body'),version=version+1 where tenant_id=p_tenant and id=p_message returning * into msg;
 update public.leads set version=version+1,context_version=context_version+case when msg.direction='INBOUND' then 1 else 0 end where tenant_id=p_tenant and id=p_lead returning * into l;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,p_lead,m.user_id,'MESSAGE_REVISED',p_request_id,trim(p_payload->>'reason'),jsonb_build_object('message_id',p_message,'version',msg.version));
 result:=jsonb_build_object('message',to_jsonb(msg),'lead_version',l.version,'context_version',l.context_version);
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
revoke all on function private.validate_lead_core(jsonb),private.validate_lead(jsonb),private.validate_facts(jsonb),private.manager_writer(uuid),private.insert_capture(uuid,jsonb,uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.update_lead_facts(uuid,uuid,jsonb,uuid,uuid),public.duplicate_candidates(uuid,uuid,integer,uuid),public.resolve_duplicate(uuid,uuid,jsonb,uuid,uuid),public.revise_message(uuid,uuid,uuid,jsonb,uuid,uuid) from public,anon;
grant execute on function public.update_lead_facts(uuid,uuid,jsonb,uuid,uuid),public.duplicate_candidates(uuid,uuid,integer,uuid),public.resolve_duplicate(uuid,uuid,jsonb,uuid,uuid),public.revise_message(uuid,uuid,uuid,jsonb,uuid,uuid) to authenticated;

-- Source: 202610060009_imports.sql
create table private.lead_imports(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),actor_id uuid not null references auth.users(id),request_key uuid not null,
 payload_hash text not null,total integer not null check(total between 1 and 1000),state text not null default 'PREVIEW' check(state in ('PREVIEW','RUNNING','COMPLETE')),
 create_separate boolean not null default false,reason text,created_at timestamptz not null default now(),unique(tenant_id,actor_id,request_key),unique(tenant_id,id));
create table private.lead_import_rows(tenant_id uuid not null,import_id uuid not null,row_index integer not null check(row_index between 1 and 1000),payload jsonb,
 state text not null default 'PENDING' check(state in ('PENDING','CREATED','DUPLICATE','INVALID','FAILED')),errors jsonb not null default '{}',attempts integer not null default 0 check(attempts between 0 and 3),lead_id uuid,
 primary key(import_id,row_index),foreign key(tenant_id,import_id) references private.lead_imports(tenant_id,id),foreign key(tenant_id,lead_id) references public.leads(tenant_id,id));
revoke all on private.lead_imports,private.lead_import_rows from public,anon,authenticated;
create index import_recent on private.lead_imports(tenant_id,created_at desc,id);
create function private.import_result(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',i.id,'state',i.state,'total',i.total,'created_at',i.created_at,'create_separate',i.create_separate,'reason',i.reason,
 'created',count(*) filter(where r.state='CREATED'),'duplicate',count(*) filter(where r.state='DUPLICATE'),'invalid',count(*) filter(where r.state='INVALID'),
 'failed',count(*) filter(where r.state='FAILED'),'pending',count(*) filter(where r.state='PENDING'),'retryable',count(*) filter(where r.state='FAILED' and r.attempts<3))
 from private.lead_imports i join private.lead_import_rows r on r.import_id=i.id where i.id=p_id group by i.id;
$$;
create function public.prepare_lead_import(p_tenant uuid,p_rows jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);i private.lead_imports;r jsonb;p jsonb;err jsonb;h text:=encode(sha256(convert_to(p_rows::text,'UTF8')),'hex');n integer:=0;target uuid;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 1000 or octet_length(p_rows::text)>10*1024*1024 then raise exception 'VALIDATION_FAILED';end if;
 select * into i from private.lead_imports where tenant_id=p_tenant and actor_id=m.user_id and request_key=p_key;if found then if i.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return private.import_result(i.id);end if;
 insert into private.lead_imports(tenant_id,actor_id,request_key,payload_hash,total) values(p_tenant,m.user_id,p_key,h,jsonb_array_length(p_rows)) returning * into i;
 for r in select value from jsonb_array_elements(p_rows) loop
  n:=n+1;err:='{}';p:=r->'payload';
  if jsonb_typeof(r) is distinct from 'object' or (r->>'row_index') is distinct from n::text or exists(select 1 from jsonb_object_keys(r) k where k not in ('row_index','payload','errors')) then raise exception 'VALIDATION_FAILED';end if;
  if r ? 'errors' then
   if jsonb_typeof(r->'errors') is distinct from 'object' or char_length((r->'errors')::text)>4000 or not exists(select 1 from jsonb_object_keys(r->'errors')) or r ? 'payload' then raise exception 'VALIDATION_FAILED';end if;
   -- Store safe errors only, never malformed raw input.
   err:=r->'errors';p:=null;
  else
   begin
    perform private.validate_lead(p-'assignee_email');
    if p ? 'assignee_id' or (p ? 'assignee_email' and jsonb_typeof(p->'assignee_email') is distinct from 'string') then raise exception 'VALIDATION_FAILED';end if;
    if coalesce(p->>'assignee_email','')<>'' then
     select x.id into target from public.memberships x join auth.users u on u.id=x.user_id where x.tenant_id=p_tenant and x.active and u.email_confirmed_at is not null and lower(trim(u.email))=lower(trim(p->>'assignee_email'));
     if not found then err:=jsonb_build_object('assignee_email','No active teammate matches this email.');end if;
    end if;
   exception when others then err:=jsonb_build_object('_row','Check the supplied fields.');end;
   if err<>'{}'::jsonb then p:=null;end if;
  end if;
  insert into private.lead_import_rows(tenant_id,import_id,row_index,payload,state,errors) values(p_tenant,i.id,n,p,case when err='{}'::jsonb then 'PENDING' else 'INVALID' end,err);
 end loop;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,m.user_id,'IMPORT_PREPARED',p_request_id,jsonb_build_object('import_id',i.id,'total',i.total));
 return private.import_result(i.id);
end;$$;
create function public.list_lead_imports(p_tenant uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 25) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);result jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select coalesce(jsonb_agg(private.import_result(x.id)),'[]') into result from (select id from private.lead_imports where tenant_id=p_tenant and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit least(greatest(p_limit,1),101)) x;return result;
end;$$;
create function public.lead_import_detail(p_tenant uuid,p_import uuid,p_after integer default 0,p_limit integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);i private.lead_imports;rows jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select * into i from private.lead_imports where tenant_id=p_tenant and id=p_import;if not found then raise exception 'NOT_FOUND';end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (select r.row_index,r.state,r.errors,r.attempts,r.lead_id,
 case when i.state='PREVIEW' then r.payload else null end as preview,
 case when i.state='PREVIEW' and r.payload is not null then exists(select 1 from public.leads l where l.tenant_id=p_tenant and ((coalesce(r.payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(r.payload->>'email'))) or (coalesce(r.payload->>'phone','')<>'' and l.phone=r.payload->>'phone'))) else false end as duplicate
 from private.lead_import_rows r where r.tenant_id=p_tenant and r.import_id=p_import and r.row_index>greatest(p_after,0) order by r.row_index limit least(greatest(p_limit,1),101)) x;
 return private.import_result(i.id)||jsonb_build_object('rows',rows);
end;$$;
create function public.process_lead_import(p_tenant uuid,p_import uuid,p_confirm jsonb,p_retry boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);i private.lead_imports;r private.lead_import_rows;target uuid;l public.leads;dupe boolean;v_reason text;separate boolean;processed integer:=0;
begin
 if p_request_id is null or p_retry is null or jsonb_typeof(p_confirm) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_confirm) k where k not in ('create_separate','reason')) or jsonb_typeof(p_confirm->'create_separate') is distinct from 'boolean' or jsonb_typeof(p_confirm->'reason') is distinct from 'string' or char_length(p_confirm->>'reason')>500 then raise exception 'VALIDATION_FAILED';end if;
 separate:=(p_confirm->>'create_separate')::boolean;v_reason:=trim(p_confirm->>'reason');if separate and char_length(v_reason)<5 then raise exception 'VALIDATION_FAILED';end if;
 select * into i from private.lead_imports where tenant_id=p_tenant and id=p_import for update;if not found then raise exception 'NOT_FOUND';end if;
 if i.state='PREVIEW' then
  update private.lead_imports set state='RUNNING',create_separate=separate,reason=v_reason where id=i.id returning * into i;
  insert into public.activity_events(tenant_id,actor_id,event_type,request_id,reason,details) values(p_tenant,m.user_id,'IMPORT_CONFIRMED',p_request_id,nullif(v_reason,''),jsonb_build_object('import_id',i.id,'create_separate',separate));
 elsif i.create_separate<>separate or i.reason<>v_reason then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 if p_retry then update private.lead_import_rows set state='PENDING' where import_id=i.id and state='FAILED' and attempts<3;end if;
 for r in select * from private.lead_import_rows where import_id=i.id and state='PENDING' order by row_index limit 25 for update loop
  processed:=processed+1;
  begin
   target:=null;perform private.validate_lead(r.payload-'assignee_email');
   if coalesce(r.payload->>'assignee_email','')<>'' then
    select x.id into target from public.memberships x join auth.users u on u.id=x.user_id where x.tenant_id=p_tenant and x.active and u.email_confirmed_at is not null and lower(trim(u.email))=lower(trim(r.payload->>'assignee_email'));
    if not found then raise exception 'VALIDATION_FAILED';end if;
   end if;
   select exists(select 1 from public.leads x where x.tenant_id=p_tenant and ((coalesce(r.payload->>'email','')<>'' and lower(trim(x.email))=lower(trim(r.payload->>'email'))) or (coalesce(r.payload->>'phone','')<>'' and x.phone=r.payload->>'phone'))) into dupe;
   if dupe and not separate then update private.lead_import_rows set state='DUPLICATE',payload=null where import_id=i.id and row_index=r.row_index;
   else
    l:=private.insert_capture(p_tenant,r.payload-'assignee_email',target,'CSV',m.user_id,p_request_id);
    if dupe then insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,l.id,m.user_id,'DUPLICATE_IMPORT_OVERRIDE',p_request_id,v_reason,jsonb_build_object('import_id',i.id,'row_index',r.row_index));end if;
    update private.lead_import_rows set state='CREATED',lead_id=l.id,payload=null,errors='{}' where import_id=i.id and row_index=r.row_index;
   end if;
  exception when others then
   update private.lead_import_rows set state=case when sqlerrm='VALIDATION_FAILED' then 'INVALID' else 'FAILED' end,
   errors=jsonb_build_object('_row',case when sqlerrm='VALIDATION_FAILED' then 'Check fields and current active assignee.' else 'Temporary write failure. Retry this row.' end),attempts=attempts+1,
   payload=case when sqlerrm='VALIDATION_FAILED' or attempts+1>=3 then null else payload end where import_id=i.id and row_index=r.row_index;
  end;
 end loop;
 update private.lead_imports set state=case when exists(select 1 from private.lead_import_rows where import_id=i.id and state='PENDING') then 'RUNNING' else 'COMPLETE' end where id=i.id;
 if processed>0 then insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,m.user_id,'IMPORT_BATCH_PROCESSED',p_request_id,jsonb_build_object('import_id',i.id,'processed',processed,'retry',p_retry));end if;
 return private.import_result(i.id);
end;$$;
revoke all on function private.import_result(uuid) from public,anon,authenticated;
revoke all on function public.prepare_lead_import(uuid,jsonb,uuid,uuid),public.list_lead_imports(uuid,timestamptz,uuid,integer),public.lead_import_detail(uuid,uuid,integer,integer),public.process_lead_import(uuid,uuid,jsonb,boolean,uuid) from public,anon;
grant execute on function public.prepare_lead_import(uuid,jsonb,uuid,uuid),public.list_lead_imports(uuid,timestamptz,uuid,integer),public.lead_import_detail(uuid,uuid,integer,integer),public.process_lead_import(uuid,uuid,jsonb,boolean,uuid) to authenticated;

-- Source: 202610060010_website_intake.sql
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

-- Source: 202610070011_analysis.sql
alter table public.agencies add column ai_daily_limit integer check(ai_daily_limit between 0 and 1000000);
alter table public.leads add column facts_confirmed_at timestamptz,add column current_analysis_id uuid;
create table private.ai_policy(singleton boolean primary key default true check(singleton),enabled boolean not null default false,model text not null default '',prompt_version text not null default 'analysis-1',schema_version text not null default 'analysis-1',rubric_approved boolean not null default false,languages text[] not null default '{}',version integer not null default 1);
insert into private.ai_policy(singleton) values(true);
create table private.ai_policy_events(id uuid primary key default gen_random_uuid(),version integer not null,enabled boolean not null,request_id uuid not null,created_at timestamptz not null default now());
create table public.ai_jobs(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),lead_id uuid not null,requester_member_id uuid not null,created_by uuid not null references auth.users(id),
 state text not null default 'QUEUED' check(state in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),version integer not null default 1,input_version integer not null,model text not null,prompt_version text not null,schema_version text not null,policy_version integer not null,
 attempts integer not null default 0 check(attempts between 0 and 3),available_at timestamptz not null default now(),lease_token uuid,lease_until timestamptz,dispatched_at timestamptz,
 uncertain_usage boolean not null default false,observed_tokens bigint not null default 0,reserved_tokens bigint not null default 192000,usage_state text not null default 'RESERVED' check(usage_state in ('RESERVED','CONSUMED','RELEASED','RECONCILE')),
 requested_at timestamptz not null default now(),completed_at timestamptz,failure_code text,month_at date not null,day_at date not null,unique(tenant_id,lead_id,id),unique(tenant_id,id),
 foreign key(tenant_id,lead_id) references public.leads(tenant_id,id),foreign key(tenant_id,requester_member_id) references public.memberships(tenant_id,id),
 check((state='RUNNING' and lease_token is not null and lease_until is not null) or (state<>'RUNNING' and lease_token is null and lease_until is null)));
create unique index one_active_analysis on public.ai_jobs(tenant_id,lead_id,input_version) where state in ('QUEUED','RUNNING');
create index analysis_claim on public.ai_jobs(state,available_at,lease_until,requested_at,id);
create index analysis_history on public.ai_jobs(tenant_id,lead_id,requested_at desc,id desc);
create table private.ai_context(job_id uuid primary key references public.ai_jobs(id),snapshot jsonb not null check(char_length(snapshot::text)<=12000),snapshot_hash text not null);
create table private.ai_usage_windows(tenant_id uuid not null references public.agencies(id),kind text not null check(kind in ('DAY','MONTH')),period_at date not null,operations integer not null check(operations>=0),primary key(tenant_id,kind,period_at));
create table private.ai_submission_limits(actor_id uuid not null references auth.users(id),hour_at timestamptz not null,count integer not null,primary key(actor_id,hour_at));
create table public.ai_analyses(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,job_id uuid not null unique,input_version integer not null,freshness text not null check(freshness in ('CURRENT','STALE')),
 result jsonb not null,model text not null,prompt_version text not null,schema_version text not null,rubric_version text not null,observed_tokens bigint not null,latency_ms integer not null,created_at timestamptz not null default now(),
 unique(tenant_id,lead_id,id),foreign key(tenant_id,lead_id,job_id) references public.ai_jobs(tenant_id,lead_id,id));
alter table public.leads add constraint current_analysis_parent foreign key(tenant_id,id,current_analysis_id) references public.ai_analyses(tenant_id,lead_id,id);
alter table public.ai_jobs enable row level security;alter table public.ai_analyses enable row level security;
create policy analysis_job_read on public.ai_jobs for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=ai_jobs.tenant_id and l.id=ai_jobs.lead_id));
create policy analysis_result_read on public.ai_analyses for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=ai_analyses.tenant_id and l.id=ai_analyses.lead_id));
revoke all on public.ai_jobs,public.ai_analyses from public,anon,authenticated;
grant select(id,tenant_id,lead_id,state,version,input_version,attempts,model,prompt_version,schema_version,requested_at,completed_at,failure_code,usage_state,observed_tokens) on public.ai_jobs to authenticated;
grant select on public.ai_analyses to authenticated;
revoke all on private.ai_policy,private.ai_policy_events,private.ai_context,private.ai_usage_windows,private.ai_submission_limits from public,anon,authenticated;
create function private.analysis_context_changed() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='INSERT' then if new.source in ('MANUAL','CSV') then new.facts_confirmed_at:=now();end if;
 elsif new.context_version<>old.context_version then
  new.current_analysis_id:=null;
  if (new.confirmed_intent,new.budget_min,new.budget_max,new.currency,new.locations,new.bedrooms,new.property_type,new.purchase_timeline) is distinct from (old.confirmed_intent,old.budget_min,old.budget_max,old.currency,old.locations,old.bedrooms,old.property_type,old.purchase_timeline) then new.facts_confirmed_at:=now();end if;
 end if;return new;
end;$$;
create trigger analysis_context_changed before insert or update on public.leads for each row execute function private.analysis_context_changed();
create function private.analysis_snapshot(l public.leads) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;messages jsonb:='[]';m record;entry jsonb;body text;remaining integer;truncated boolean:=false;seen integer:=0;
begin
 result:=jsonb_build_object('confirmed',jsonb_build_object('confirmed_intent',l.confirmed_intent,'budget_min',l.budget_min,'budget_max',l.budget_max,'currency',l.currency,'budget_period',l.budget_period,'locations',l.locations,'property_type',l.property_type,'bedrooms',l.bedrooms,'purchase_timeline',l.purchase_timeline),
 'facts_confirmed_at',l.facts_confirmed_at,'requested_at',now(),'truncated',false,'messages',messages);
 for m in select msg.id,msg.version,msg.body,msg.occurred_at from public.messages msg where msg.tenant_id=l.tenant_id and msg.lead_id=l.id and msg.direction='INBOUND' order by msg.occurred_at desc,msg.created_at desc,msg.id desc limit 51 loop
  seen:=seen+1;if seen>50 then truncated:=true;exit;end if;
  body:=regexp_replace(m.body,'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}','[email removed]','g');
  if nullif(l.phone,'') is not null then body:=replace(body,l.phone,'[phone removed]');end if;
  body:=regexp_replace(body,'\+[0-9][0-9 ().-]{6,20}','[phone removed]','g');
  remaining:=12000-char_length(result::text)-2;if remaining<260 then truncated:=true;exit;end if;
  entry:=jsonb_build_object('id',m.id,'version',m.version,'body',body,'occurred_at',m.occurred_at);
  while char_length(entry::text)>remaining loop truncated:=true;body:=left(body,greatest(0,char_length(body)-greatest(1,(char_length(entry::text)-remaining)/2)));entry:=jsonb_set(entry,'{body}',to_jsonb(body));end loop;
  messages:=messages||jsonb_build_array(entry);result:=jsonb_set(result,'{messages}',messages);
  if truncated then exit;end if;
 end loop;
 return jsonb_set(result,'{truncated}',to_jsonb(truncated));
end;$$;
create function private.analysis_allowed(j public.ai_jobs) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.leads l join public.agencies a on a.id=l.tenant_id join public.memberships m on m.tenant_id=l.tenant_id and m.id=j.requester_member_id join auth.users u on u.id=m.user_id cross join private.ai_policy p
 where l.tenant_id=j.tenant_id and l.id=j.lead_id and l.archived_at is null and l.status not in ('WON','LOST') and m.active and u.email_confirmed_at is not null and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
 and a.ai_enabled and a.processing_approved and p.enabled and p.rubric_approved and p.version=j.policy_version and p.model=j.model and p.prompt_version=j.prompt_version and p.schema_version=j.schema_version);
$$;
create function public.submit_analysis(p_tenant uuid,p_lead uuid,p_expected_version integer,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;a public.agencies;p private.ai_policy;j public.ai_jobs;r private.api_requests;op text:='analysis:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(coalesce(p_expected_version::text,''),'UTF8')),'hex');snapshot jsonb;used integer;month_at date:=(date_trunc('month',now() at time zone 'UTC'))::date;day_at date:=(now() at time zone 'UTC')::date;result jsonb;
begin
 if p_key is null or p_request_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into a from public.agencies where id=p_tenant;select * into p from private.ai_policy;
 if not p.enabled or not p.rubric_approved then raise exception 'AI_DISABLED';end if;if not a.ai_enabled or not a.processing_approved then raise exception 'PROCESSING_REQUIRED';end if;
 if l.archived_at is not null or l.status in ('WON','LOST') then raise exception 'CONTACT_BLOCKED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if l.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 select * into j from public.ai_jobs where tenant_id=p_tenant and lead_id=p_lead and input_version=l.context_version and state in ('QUEUED','RUNNING');
 if found then result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',true);
 else
  if a.ai_monthly_limit is null or a.ai_daily_limit is null then raise exception 'AI_LIMIT_REQUIRED';end if;
  insert into private.ai_submission_limits values(m.user_id,date_trunc('hour',now()),1) on conflict(actor_id,hour_at) do update set count=ai_submission_limits.count+1 returning count into used;
  if used>10 then raise exception 'AI_RATE_LIMITED';end if;
  insert into private.ai_usage_windows values(p_tenant,'MONTH',month_at,0) on conflict do nothing;insert into private.ai_usage_windows values(p_tenant,'DAY',day_at,0) on conflict do nothing;
  if (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=month_at)>=a.ai_monthly_limit or (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=day_at)>=a.ai_daily_limit then raise exception 'AI_QUOTA_REACHED';end if;
  update private.ai_usage_windows set operations=operations+1 where tenant_id=p_tenant and (kind='MONTH' and period_at=month_at or kind='DAY' and period_at=day_at);
  snapshot:=private.analysis_snapshot(l);
  insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at) values(p_tenant,p_lead,m.id,m.user_id,l.context_version,p.model,p.prompt_version,p.schema_version,p.version,month_at,day_at) returning * into j;
  insert into private.ai_context values(j.id,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,p_lead,m.user_id,'ANALYSIS_QUEUED',p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'truncated',snapshot->'truncated'));
  result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',false);
 end if;
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create function private.end_analysis(p_job uuid,p_state text,p_code text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;settled text;
begin
 select * into j from public.ai_jobs where id=p_job for update;
 settled:=case when j.uncertain_usage then 'RECONCILE' when j.observed_tokens>0 then 'CONSUMED' else 'RELEASED' end;
 if j.usage_state='RESERVED' and settled='RELEASED' then update private.ai_usage_windows set operations=operations-1 where tenant_id=j.tenant_id and (kind='DAY' and period_at=j.day_at or kind='MONTH' and period_at=j.month_at);end if;
 update public.ai_jobs set state=p_state,failure_code=p_code,usage_state=case when usage_state='RESERVED' then settled else usage_state end,lease_token=null,lease_until=null,completed_at=now(),reserved_tokens=case when settled='RECONCILE' then greatest(0,reserved_tokens-observed_tokens) else 0 end,version=version+1 where id=j.id returning * into j;
 delete from private.ai_context where job_id=j.id;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(j.tenant_id,j.lead_id,null,'ANALYSIS_'||p_state,p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'failure_code',p_code,'usage_state',j.usage_state));
 if p_state='FAILED' and private.analysis_allowed(j) and exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then
  insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_FAILED',j.id,j.lead_id,'analysis-failed:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;
 end if;
 return jsonb_build_object('state',j.state,'usage_state',j.usage_state);
end;$$;
alter table public.notifications add column input_version integer;
create function public.cancel_analysis(p_tenant uuid,p_job uuid,p_expected_version integer,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);j public.ai_jobs;r private.api_requests;op text:='cancel-analysis:'||p_tenant||':'||p_job;h text:=encode(sha256(convert_to(coalesce(p_expected_version::text,''),'UTF8')),'hex');result jsonb;
begin
 if p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select x.* into j from public.ai_jobs x join public.leads l on l.tenant_id=x.tenant_id and l.id=x.lead_id where x.tenant_id=p_tenant and x.id=p_job and (m.role<>'AGENT' or l.assignee_id=m.id) for update of x;if not found then raise exception 'NOT_FOUND';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if j.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;if j.state not in ('QUEUED','RUNNING') then raise exception 'STATE_CONFLICT';end if;
 update public.ai_jobs set uncertain_usage=uncertain_usage or dispatched_at is not null where id=j.id;result:=private.end_analysis(j.id,'CANCELLED','USER_CANCELLED',p_request_id);
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create function public.worker_set_ai_policy(p_enabled boolean,p_model text,p_languages text[],p_rubric_approved boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.ai_policy;
begin
 perform private.require_worker();if p_enabled is null or p_rubric_approved is null or p_request_id is null or p_model is null or char_length(p_model)>120 or p_languages is null or cardinality(p_languages)>3 or exists(select 1 from unnest(p_languages) l where l not in ('en','ar','mixed')) or (p_enabled and (not p_rubric_approved or cardinality(p_languages)=0 or p_model !~ '^[a-zA-Z0-9._:-]{1,120}$')) then raise exception 'VALIDATION_FAILED';end if;
 select * into p from private.ai_policy for update;
 if (p.enabled,p.model,p.languages,p.rubric_approved) is distinct from (p_enabled,p_model,p_languages,p_rubric_approved) then
  update private.ai_policy set enabled=p_enabled,model=p_model,languages=p_languages,rubric_approved=p_rubric_approved,version=version+1 returning * into p;
  insert into private.ai_policy_events(version,enabled,request_id) values(p.version,p.enabled,p_request_id);
 end if;return jsonb_build_object('enabled',p.enabled,'version',p.version);
end;$$;
create function public.worker_claim_analysis(p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;j public.ai_jobs;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 for candidate in select id,tenant_id from public.ai_jobs where state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now() order by requested_at,id limit 20 loop
  perform 1 from public.agencies where id=candidate.tenant_id for update;
  select * into j from public.ai_jobs where id=candidate.id and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) for update skip locked;if not found then continue;end if;
  if j.state='RUNNING' and j.dispatched_at is not null then update public.ai_jobs set uncertain_usage=true where id=j.id returning * into j;end if;
  if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);continue;end if;
  if j.attempts>=3 then perform private.end_analysis(j.id,'FAILED','LEASE_EXHAUSTED',p_request_id);continue;end if;
  update public.ai_jobs set state='RUNNING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',dispatched_at=null,version=version+1 where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'lease_token',j.lease_token,'attempt',j.attempts,'model',j.model);
 end loop;return null;
end;$$;
create function public.worker_prepare_analysis(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;snapshot jsonb;languages text[];
begin
 perform private.require_worker();select * into j from public.ai_jobs where id=p_job;if not found then return null;end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return null;end if;
 if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);return null;end if;
 select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;select p.languages into languages from private.ai_policy p;
 update public.ai_jobs set dispatched_at=now() where id=j.id;
 return jsonb_build_object('snapshot',snapshot,'model',j.model,'languages',languages,'input_version',j.input_version);
end;$$;
create function public.worker_fail_analysis(p_job uuid,p_lease uuid,p_code text,p_transient boolean,p_tokens integer,p_uncertain boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;
begin
 perform private.require_worker();if p_code is null or p_code not in ('PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_UNAVAILABLE','PROVIDER_CONFIG','REFUSED','INCOMPLETE','INVALID_SCHEMA','INVALID_EVIDENCE','UNSUPPORTED_SUMMARY','UNSAFE_OUTPUT','UNKNOWN_CURRENCY','TRANSIENT_DATABASE_FAILURE','AI_DISABLED') or p_transient is null or p_uncertain is null or p_request_id is null or (p_tokens is not null and p_tokens not between 0 and 250000) then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update public.ai_jobs set observed_tokens=observed_tokens+coalesce(p_tokens,0),uncertain_usage=uncertain_usage or p_uncertain where id=j.id returning * into j;
 if not private.analysis_allowed(j) then return private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);end if;
 if p_transient and j.attempts<3 then
  update public.ai_jobs set state='QUEUED',lease_token=null,lease_until=null,dispatched_at=null,available_at=now()+make_interval(secs=>30*power(2,attempts-1)::integer+floor(random()*11)::integer),failure_code=p_code,version=version+1 where id=j.id;
  return jsonb_build_object('state','QUEUED');
 end if;return private.end_analysis(j.id,'FAILED',p_code,p_request_id);
end;$$;
create function public.worker_finish_analysis(p_job uuid,p_lease uuid,p_result jsonb,p_tokens integer,p_latency integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;l public.leads;result public.ai_analyses;snapshot jsonb;e jsonb;fresh text;
begin
 perform private.require_worker();if p_request_id is null or p_tokens is null or p_tokens not between 0 and 250000 or p_latency is null or p_latency not between 0 and 90000 or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>48000 or p_result->>'rubric_version' is distinct from 'proposed-1' or jsonb_typeof(p_result->'score') is distinct from 'number' or (p_result->>'score')::numeric not between 0 and 100 or p_result->'analysis'->>'schema_version' is distinct from 'analysis-1' or jsonb_typeof(p_result->'analysis'->'field_evidence') is distinct from 'array' then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update public.ai_jobs set observed_tokens=observed_tokens+p_tokens where id=j.id returning * into j;
 if not private.analysis_allowed(j) then return private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);end if;
 select * into l from public.leads where tenant_id=j.tenant_id and id=j.lead_id for update;select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;
 for e in select value from jsonb_array_elements(p_result->'analysis'->'field_evidence') loop
  if not exists(select 1 from jsonb_array_elements(snapshot->'messages') m where m->>'id'=e->>'message_id' and m->>'version'=e->>'message_version' and char_length(e->>'excerpt') between 1 and 240 and strpos(m->>'body',e->>'excerpt')>0) then raise exception 'INVALID_EVIDENCE';end if;
 end loop;
 fresh:=case when l.context_version=j.input_version then 'CURRENT' else 'STALE' end;
 insert into public.ai_analyses(tenant_id,lead_id,job_id,input_version,freshness,result,model,prompt_version,schema_version,rubric_version,observed_tokens,latency_ms) values(j.tenant_id,j.lead_id,j.id,j.input_version,fresh,p_result,j.model,j.prompt_version,j.schema_version,'proposed-1',j.observed_tokens,p_latency) returning * into result;
 if fresh='CURRENT' then update public.leads set current_analysis_id=result.id where tenant_id=j.tenant_id and id=j.lead_id;end if;
 perform private.end_analysis(j.id,'SUCCEEDED',null,p_request_id);
 if fresh='CURRENT' then insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_READY',j.id,j.lead_id,'analysis-ready:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;end if;
 return jsonb_build_object('state','SUCCEEDED','freshness',fresh,'analysis_id',result.id);
end;$$;
create function public.worker_analysis_metrics() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_worker();return jsonb_build_object('queued',(select count(*) from public.ai_jobs where state='QUEUED'),'failed',(select count(*) from public.ai_jobs where state='FAILED'),'usage_reconciliation',(select count(*) from public.ai_jobs where usage_state='RECONCILE'),'oldest_queued_seconds',(select coalesce(max(extract(epoch from now()-requested_at)),0) from public.ai_jobs where state='QUEUED'));
end;$$;
create function public.analysis_usage(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);a public.agencies;
begin
 if m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;select * into a from public.agencies where id=p_tenant;
 return jsonb_build_object('daily_limit',a.ai_daily_limit,'monthly_limit',a.ai_monthly_limit,'daily_operations',coalesce((select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=(now() at time zone 'UTC')::date),0),
 'monthly_operations',coalesce((select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=date_trunc('month',now() at time zone 'UTC')::date),0),'reconciliation',(select count(*) from public.ai_jobs where tenant_id=p_tenant and usage_state='RECONCILE'));
end;$$;
revoke all on function private.analysis_context_changed(),private.analysis_snapshot(public.leads),private.analysis_allowed(public.ai_jobs),private.end_analysis(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.submit_analysis(uuid,uuid,integer,uuid,uuid),public.cancel_analysis(uuid,uuid,integer,uuid,uuid),public.analysis_usage(uuid) from public,anon;
grant execute on function public.submit_analysis(uuid,uuid,integer,uuid,uuid),public.cancel_analysis(uuid,uuid,integer,uuid,uuid),public.analysis_usage(uuid) to authenticated;
revoke all on function public.worker_set_ai_policy(boolean,text,text[],boolean,uuid),public.worker_claim_analysis(uuid),public.worker_prepare_analysis(uuid,uuid,uuid),public.worker_fail_analysis(uuid,uuid,text,boolean,integer,boolean,uuid),public.worker_finish_analysis(uuid,uuid,jsonb,integer,integer,uuid),public.worker_analysis_metrics() from public,anon,authenticated;
grant execute on function public.worker_set_ai_policy(boolean,text,text[],boolean,uuid),public.worker_claim_analysis(uuid),public.worker_prepare_analysis(uuid,uuid,uuid),public.worker_fail_analysis(uuid,uuid,text,boolean,integer,boolean,uuid),public.worker_finish_analysis(uuid,uuid,jsonb,integer,integer,uuid),public.worker_analysis_metrics() to service_role;
create or replace function public.team_snapshot(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);agency public.agencies;email text;result jsonb;
begin
 select * into agency from public.agencies where id=p_tenant;select u.email into email from auth.users u where u.id=auth.uid();
 result:=jsonb_build_object('membership',jsonb_build_object('id',member.id,'role',member.role,'version',member.version,'display_name',member.display_name,'email',email),
 'agency',jsonb_build_object('id',agency.id,'name',agency.name,'timezone',agency.timezone,'locale',agency.locale,'version',agency.version,'ai_enabled',agency.ai_enabled,'processing_approved',agency.processing_approved,'processing_reference',case when member.role in ('OWNER','ADMIN') then agency.processing_reference else null end),
 'pilot',case when member.role='OWNER' then jsonb_build_object('seat_limit',agency.seat_limit,'ai_monthly_limit',agency.ai_monthly_limit,'ai_daily_limit',agency.ai_daily_limit,'active_seats',(select count(*) from public.memberships m where m.tenant_id=p_tenant and m.active),'pending_seats',(select count(*) from public.invitations i where i.tenant_id=p_tenant and i.state='PENDING' and i.expires_at>now())) else null end,
 'onboarding',case when member.role in ('OWNER','ADMIN') then jsonb_build_object('Agency details',char_length(agency.name)>=2,'Processing settings',agency.processing_approved,'Invite team',(select exists(select 1 from public.invitations i where i.tenant_id=p_tenant)),'Sample lead',(select exists(select 1 from public.leads l where l.tenant_id=p_tenant)),'Schedule reminder',(select exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant))) else null end);
 return result;
end; $$;
create or replace function public.update_agency_settings(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);agency public.agencies;prior private.api_requests;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');v_operation text:='settings:'||p_tenant::text;result jsonb;seats integer;cap integer;daily integer;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['expected_version','name','timezone','locale','processing_approved','processing_reference','ai_enabled','seat_limit','ai_monthly_limit','ai_daily_limit']);
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload->'name') is distinct from 'string' or char_length(trim(p_payload->>'name')) not between 2 and 120
 or p_payload->>'locale' is distinct from 'en' or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_payload->>'timezone')
 or jsonb_typeof(p_payload->'processing_approved') is distinct from 'boolean' or jsonb_typeof(p_payload->'ai_enabled') is distinct from 'boolean'
 or jsonb_typeof(p_payload->'processing_reference') is distinct from 'string' or char_length(p_payload->>'processing_reference')>500
 or (p_payload->'processing_approved'='true'::jsonb and char_length(trim(p_payload->>'processing_reference'))<5) then raise exception 'VALIDATION_FAILED';end if;
 if member.role<>'OWNER' and (p_payload ? 'seat_limit' or p_payload ? 'ai_monthly_limit' or p_payload ? 'ai_daily_limit') then raise exception 'ROLE_REQUIRED';end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.response;end if;
 select * into agency from public.agencies where id=p_tenant;
 if p_payload->>'expected_version' is distinct from agency.version::text then raise exception 'VERSION_CONFLICT';end if;
 seats:=agency.seat_limit;cap:=agency.ai_monthly_limit;daily:=agency.ai_daily_limit;
 if p_payload ? 'seat_limit' then
  if p_payload->'seat_limit'='null'::jsonb then seats:=null;
  elsif jsonb_typeof(p_payload->'seat_limit')='number' and p_payload->>'seat_limit' ~ '^[0-9]{1,5}$' then seats:=(p_payload->>'seat_limit')::integer;if seats not between 1 and 10000 then raise exception 'VALIDATION_FAILED';end if;
  else raise exception 'VALIDATION_FAILED';end if;
 end if;
 if p_payload ? 'ai_monthly_limit' then
  if p_payload->'ai_monthly_limit'='null'::jsonb then cap:=null;
  elsif jsonb_typeof(p_payload->'ai_monthly_limit')='number' and p_payload->>'ai_monthly_limit' ~ '^[0-9]{1,7}$' then cap:=(p_payload->>'ai_monthly_limit')::integer;if cap not between 0 and 1000000 then raise exception 'VALIDATION_FAILED';end if;
  else raise exception 'VALIDATION_FAILED';end if;
 end if;
 if p_payload ? 'ai_daily_limit' then
  if p_payload->'ai_daily_limit'='null'::jsonb then daily:=null;
  elsif jsonb_typeof(p_payload->'ai_daily_limit')='number' and p_payload->>'ai_daily_limit' ~ '^[0-9]{1,7}$' then daily:=(p_payload->>'ai_daily_limit')::integer;if daily not between 0 and 1000000 then raise exception 'VALIDATION_FAILED';end if;
  else raise exception 'VALIDATION_FAILED';end if;
 end if;
 if seats is not null and seats<private.seat_count(p_tenant) then raise exception 'SEAT_LIMIT_REACHED';end if;
 if p_payload->'ai_enabled'='true'::jsonb and (p_payload->'processing_approved'<>'true'::jsonb or cap is null) then raise exception 'PROCESSING_REQUIRED';end if;
 update public.agencies set name=trim(p_payload->>'name'),timezone=p_payload->>'timezone',locale='en',processing_approved=(p_payload->>'processing_approved')::boolean,
 processing_reference=nullif(trim(p_payload->>'processing_reference'),''),ai_enabled=(p_payload->>'ai_enabled')::boolean,seat_limit=seats,ai_monthly_limit=cap,ai_daily_limit=daily,version=version+1 where id=p_tenant returning * into agency;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'AGENCY_SETTINGS_UPDATED',p_request_id,jsonb_build_object('agency_version',agency.version,'processing_approved',agency.processing_approved,'ai_enabled',agency.ai_enabled));
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(p_tenant,'AGENCY_SETTINGS_CHANGED',p_tenant,v_operation||':'||p_key::text,jsonb_build_object('version',agency.version));
 result:=jsonb_build_object('id',agency.id,'version',agency.version);insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
create or replace function private.notice_current(n public.notifications) returns boolean language plpgsql stable security definer set search_path='' as $$
declare member public.memberships;lead public.leads;task public.follow_ups;
begin
 if not private.recipient_access(n.tenant_id,n.recipient_id,n.lead_id,n.task_id) then return false;end if;
 select * into member from public.memberships where tenant_id=n.tenant_id and id=n.recipient_id and active;
 if n.type='INVITE_ACCEPTED' then return member.role in ('OWNER','ADMIN') and exists(select 1 from public.memberships m where m.tenant_id=n.tenant_id and m.id=n.resource_id and m.active and (member.role='OWNER' or m.role='AGENT'));end if;
 if n.lead_id is null then return false;end if;
 select * into lead from public.leads where tenant_id=n.tenant_id and id=n.lead_id;
 if not found or lead.archived_at is not null or lead.status in ('WON','LOST') then return false;end if;
 if n.type='LEAD_ASSIGNED' then return lead.assignment_version=n.assignment_version and (lead.assignee_id=n.recipient_id or lead.assignee_id is null and member.role in ('OWNER','ADMIN'));end if;
 if n.type='MANAGER_REVIEW' then return lead.duplicate_review and lead.review_version=n.review_version and member.role in ('OWNER','ADMIN');end if;
 if n.type='FOLLOW_UP_DUE' then
  select * into task from public.follow_ups where tenant_id=n.tenant_id and id=n.task_id and lead_id=n.lead_id;
  return found and task.state='OPEN' and task.schedule_version=n.schedule_version and task.due_at<=now() and (not lead.do_not_contact or task.type='INTERNAL') and (task.assignee_id=n.recipient_id or task.assignee_id is null and member.role in ('OWNER','ADMIN'));
 end if;
 if n.type in ('AI_READY','AI_FAILED') then
  return lead.context_version=n.input_version and exists(select 1 from public.ai_jobs j where j.tenant_id=n.tenant_id and j.lead_id=n.lead_id and j.id=n.resource_id and j.requester_member_id=n.recipient_id and j.input_version=n.input_version and (n.type='AI_READY' and j.state='SUCCEEDED' and exists(select 1 from public.ai_analyses a where a.job_id=j.id and a.id=lead.current_analysis_id) or n.type='AI_FAILED' and j.state='FAILED'));
 end if;
 return false;
end; $$;

-- Source: 202610070012_drafts.sql
alter table public.ai_jobs add column kind text not null default 'ANALYSIS' check(kind in ('ANALYSIS','DRAFT')),add column parameter_hash text,add column draft_policy_version integer;
grant select(kind) on public.ai_jobs to authenticated;
drop index public.one_active_analysis;
create unique index one_active_analysis on public.ai_jobs(tenant_id,lead_id,input_version,kind) where state in ('QUEUED','RUNNING');
create table private.draft_policy(singleton boolean primary key default true check(singleton),enabled boolean not null default false,version integer not null default 1);
insert into private.draft_policy(singleton) values(true);
create table public.reply_drafts(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,job_id uuid not null unique,input_version integer not null,
 state text not null check(state in ('GENERATED','EDITED','APPROVED','REJECTED','COPIED','SUPERSEDED','WITHHELD')),freshness text not null check(freshness in ('CURRENT','STALE')),version integer not null default 1,content_version integer not null default 1,
 original_text text not null check(char_length(original_text) between 1 and 5000),working_text text not null check(char_length(working_text) between 1 and 5000),language text not null check(language in ('en','ar')),tone text not null check(tone in ('PROFESSIONAL','FRIENDLY')),
 safety_flags jsonb not null default '[]',outline jsonb not null,model text not null,prompt_version text not null,schema_version text not null,observed_tokens bigint not null,latency_ms integer not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 approved_by uuid,approved_member_version integer,approved_assignment_version integer,approved_content_version integer,approved_input_version integer,approved_at timestamptz,rejection_reason text,
 unique(tenant_id,id),unique(tenant_id,lead_id,id),foreign key(tenant_id,lead_id,job_id) references public.ai_jobs(tenant_id,lead_id,id),foreign key(tenant_id,approved_by) references public.memberships(tenant_id,id));
create table public.draft_feedback(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,draft_id uuid not null,actor_id uuid not null references auth.users(id),content_version integer not null,
 category text not null check(category in ('USEFUL','INCORRECT','UNSAFE','UNHELPFUL')),comment text not null check(char_length(comment)<=500),created_at timestamptz not null default now(),foreign key(tenant_id,lead_id,draft_id) references public.reply_drafts(tenant_id,lead_id,id));
create table private.draft_copy_receipts(token uuid primary key default gen_random_uuid(),tenant_id uuid not null,draft_id uuid not null,actor_id uuid not null references auth.users(id),content_version integer not null,draft_version integer not null,expires_at timestamptz not null default now()+interval '2 minutes',completed_at timestamptz,foreign key(tenant_id,draft_id) references public.reply_drafts(tenant_id,id));
alter table public.reply_drafts enable row level security;alter table public.draft_feedback enable row level security;
create policy draft_read on public.reply_drafts for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=reply_drafts.tenant_id and l.id=reply_drafts.lead_id));
create policy draft_feedback_read on public.draft_feedback for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=draft_feedback.tenant_id and l.id=draft_feedback.lead_id));
revoke all on public.reply_drafts,public.draft_feedback from public,anon,authenticated;grant select on public.reply_drafts,public.draft_feedback to authenticated;
revoke all on private.draft_policy,private.draft_copy_receipts from public,anon,authenticated;
create function private.draft_safety(p_text text) returns jsonb language sql immutable set search_path='' as $$ select case when p_text ~* 'guarantee|guaranteed|guarantees|guaranteeing|مضمون|نضمن|مضمونة|visa|legal|financing|mortgage|تأشيرة|قانوني|تمويل|رهن|discount|خصم|available now|available today|is available|are available|available villas?|available units?|available apartments?|we have [0-9]+ (?:units?|villas?|apartments?)|confirmed viewing|booked|متاح الآن|متاحة الآن|مخفض|حجز مؤكد|ignore previous|ignore all|system prompt|api key|تجاهل التعليمات|<script|javascript:' then jsonb_build_array('UNSUPPORTED_OR_UNSAFE_CLAIM') else '[]'::jsonb end $$;
create or replace function private.analysis_allowed(j public.ai_jobs) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.leads l join public.agencies a on a.id=l.tenant_id join public.memberships m on m.tenant_id=l.tenant_id and m.id=j.requester_member_id join auth.users u on u.id=m.user_id cross join private.ai_policy p
 where l.tenant_id=j.tenant_id and l.id=j.lead_id and l.archived_at is null and l.status not in ('WON','LOST') and m.active and u.email_confirmed_at is not null and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
 and a.ai_enabled and a.processing_approved and p.enabled and p.rubric_approved and p.version=j.policy_version and p.model=j.model and j.prompt_version=case when j.kind='DRAFT' then 'draft-1' else p.prompt_version end and j.schema_version=case when j.kind='DRAFT' then 'draft-1' else p.schema_version end and (j.kind='ANALYSIS' or (not l.do_not_contact and exists(select 1 from private.draft_policy d where d.enabled and d.version=j.draft_policy_version))));
$$;
create function public.submit_draft(p_tenant uuid,p_lead uuid,p_expected_version integer,p_options jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;a public.agencies;p private.ai_policy;j public.ai_jobs;r private.api_requests;op text:='draft:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(jsonb_build_array(p_expected_version,p_options)::text,'UTF8')),'hex');snapshot jsonb;used integer;month_at date:=(date_trunc('month',now() at time zone 'UTC'))::date;day_at date:=(now() at time zone 'UTC')::date;result jsonb;draft_policy private.draft_policy;options jsonb;
begin
 if p_key is null or p_request_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 perform private.team_payload(p_options,array['language','tone','instruction']);
 if p_options->>'language' is null or p_options->>'language' not in ('en','ar') or p_options->>'tone' is null or p_options->>'tone' not in ('PROFESSIONAL','FRIENDLY') or jsonb_typeof(p_options->'instruction') is distinct from 'string' or char_length(p_options->>'instruction')>500 then raise exception 'VALIDATION_FAILED';end if;
 options:=p_options;
 options:=jsonb_set(options,'{instruction}',to_jsonb(regexp_replace(p_options->>'instruction','[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+[0-9][0-9 ().-]{6,20}','[contact removed]','g')));
 select * into draft_policy from private.draft_policy;
 if not draft_policy.enabled then raise exception 'DRAFT_DISABLED';end if;
 select * into a from public.agencies where id=p_tenant;select * into p from private.ai_policy;
 if not p.enabled or not p.rubric_approved then raise exception 'AI_DISABLED';end if;if not a.ai_enabled or not a.processing_approved then raise exception 'PROCESSING_REQUIRED';end if;
 if l.do_not_contact or l.archived_at is not null or l.status in ('WON','LOST') then raise exception 'CONTACT_BLOCKED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if l.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 select * into j from public.ai_jobs where tenant_id=p_tenant and lead_id=p_lead and input_version=l.context_version and state in ('QUEUED','RUNNING') and kind='DRAFT';
 if found then if j.parameter_hash is distinct from encode(sha256(convert_to(options::text,'UTF8')),'hex') then raise exception 'DRAFT_IN_PROGRESS';end if;result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',true);
 else
  if a.ai_monthly_limit is null or a.ai_daily_limit is null then raise exception 'AI_LIMIT_REQUIRED';end if;
  insert into private.ai_submission_limits values(m.user_id,date_trunc('hour',now()),1) on conflict(actor_id,hour_at) do update set count=ai_submission_limits.count+1 returning count into used;
  if used>10 then raise exception 'AI_RATE_LIMITED';end if;
  insert into private.ai_usage_windows values(p_tenant,'MONTH',month_at,0) on conflict do nothing;insert into private.ai_usage_windows values(p_tenant,'DAY',day_at,0) on conflict do nothing;
  if (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=month_at)>=a.ai_monthly_limit or (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=day_at)>=a.ai_daily_limit then raise exception 'AI_QUOTA_REACHED';end if;
  update private.ai_usage_windows set operations=operations+1 where tenant_id=p_tenant and (kind='MONTH' and period_at=month_at or kind='DAY' and period_at=day_at);
  if not (p_options->>'language'=any(p.languages)) then raise exception 'DRAFT_LANGUAGE_UNAPPROVED';end if;
  snapshot:=private.analysis_snapshot(l)||jsonb_build_object('draft_options',options);
  while char_length(snapshot::text)>12000 loop if jsonb_array_length(snapshot->'messages')=0 then raise exception 'VALIDATION_FAILED';end if;snapshot:=jsonb_set(snapshot,'{messages}',(snapshot->'messages')-(jsonb_array_length(snapshot->'messages')-1));snapshot:=jsonb_set(snapshot,'{truncated}','true');end loop;
  insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at,kind,parameter_hash,draft_policy_version) values(p_tenant,p_lead,m.id,m.user_id,l.context_version,p.model,'draft-1','draft-1',p.version,month_at,day_at,'DRAFT',encode(sha256(convert_to(options::text,'UTF8')),'hex'),draft_policy.version) returning * into j;
  insert into private.ai_context values(j.id,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,p_lead,m.user_id,'DRAFT_QUEUED',p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'truncated',snapshot->'truncated'));
  result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',false);
 end if;
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create or replace function public.submit_analysis(p_tenant uuid,p_lead uuid,p_expected_version integer,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;a public.agencies;p private.ai_policy;j public.ai_jobs;r private.api_requests;op text:='analysis:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(coalesce(p_expected_version::text,''),'UTF8')),'hex');snapshot jsonb;used integer;month_at date:=(date_trunc('month',now() at time zone 'UTC'))::date;day_at date:=(now() at time zone 'UTC')::date;result jsonb;
begin
 if p_key is null or p_request_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into a from public.agencies where id=p_tenant;select * into p from private.ai_policy;
 if not p.enabled or not p.rubric_approved then raise exception 'AI_DISABLED';end if;if not a.ai_enabled or not a.processing_approved then raise exception 'PROCESSING_REQUIRED';end if;
 if l.archived_at is not null or l.status in ('WON','LOST') then raise exception 'CONTACT_BLOCKED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if l.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 select * into j from public.ai_jobs where tenant_id=p_tenant and lead_id=p_lead and input_version=l.context_version and state in ('QUEUED','RUNNING') and kind='ANALYSIS';
 if found then result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',true);
 else
  if a.ai_monthly_limit is null or a.ai_daily_limit is null then raise exception 'AI_LIMIT_REQUIRED';end if;
  insert into private.ai_submission_limits values(m.user_id,date_trunc('hour',now()),1) on conflict(actor_id,hour_at) do update set count=ai_submission_limits.count+1 returning count into used;
  if used>10 then raise exception 'AI_RATE_LIMITED';end if;
  insert into private.ai_usage_windows values(p_tenant,'MONTH',month_at,0) on conflict do nothing;insert into private.ai_usage_windows values(p_tenant,'DAY',day_at,0) on conflict do nothing;
  if (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=month_at)>=a.ai_monthly_limit or (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=day_at)>=a.ai_daily_limit then raise exception 'AI_QUOTA_REACHED';end if;
  update private.ai_usage_windows set operations=operations+1 where tenant_id=p_tenant and (kind='MONTH' and period_at=month_at or kind='DAY' and period_at=day_at);
  snapshot:=private.analysis_snapshot(l);
  insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at) values(p_tenant,p_lead,m.id,m.user_id,l.context_version,p.model,p.prompt_version,p.schema_version,p.version,month_at,day_at) returning * into j;
  insert into private.ai_context values(j.id,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,p_lead,m.user_id,'ANALYSIS_QUEUED',p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'truncated',snapshot->'truncated'));
  result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',false);
 end if;
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create or replace function public.worker_claim_analysis(p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;j public.ai_jobs;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 for candidate in select id,tenant_id from public.ai_jobs where kind='ANALYSIS' and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) order by requested_at,id limit 20 loop
  perform 1 from public.agencies where id=candidate.tenant_id for update;
  select * into j from public.ai_jobs where id=candidate.id and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) for update skip locked;if not found then continue;end if;
  if j.state='RUNNING' and j.dispatched_at is not null then update public.ai_jobs set uncertain_usage=true where id=j.id returning * into j;end if;
  if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);continue;end if;
  if j.attempts>=3 then perform private.end_analysis(j.id,'FAILED','LEASE_EXHAUSTED',p_request_id);continue;end if;
  update public.ai_jobs set state='RUNNING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',dispatched_at=null,version=version+1 where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'lease_token',j.lease_token,'attempt',j.attempts,'model',j.model);
 end loop;return null;
end;$$;
create function public.worker_claim_draft(p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;j public.ai_jobs;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 for candidate in select id,tenant_id from public.ai_jobs where kind='DRAFT' and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) order by requested_at,id limit 20 loop
  perform 1 from public.agencies where id=candidate.tenant_id for update;
  select * into j from public.ai_jobs where id=candidate.id and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) for update skip locked;if not found then continue;end if;
  if j.state='RUNNING' and j.dispatched_at is not null then update public.ai_jobs set uncertain_usage=true where id=j.id returning * into j;end if;
  if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);continue;end if;
  if j.attempts>=3 then perform private.end_analysis(j.id,'FAILED','LEASE_EXHAUSTED',p_request_id);continue;end if;
  update public.ai_jobs set state='RUNNING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',dispatched_at=null,version=version+1 where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'lease_token',j.lease_token,'attempt',j.attempts,'model',j.model);
 end loop;return null;
end;$$;
create or replace function public.worker_prepare_analysis(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;snapshot jsonb;languages text[];
begin
 perform private.require_worker();select * into j from public.ai_jobs where id=p_job;if not found then return null;end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'ANALYSIS' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return null;end if;
 if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);return null;end if;
 select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;select p.languages into languages from private.ai_policy p;
 update public.ai_jobs set dispatched_at=now() where id=j.id;
 return jsonb_build_object('snapshot',snapshot,'model',j.model,'languages',languages,'input_version',j.input_version);
end;$$;
create function public.worker_prepare_draft(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;snapshot jsonb;languages text[];
begin
 perform private.require_worker();select * into j from public.ai_jobs where id=p_job;if not found then return null;end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'DRAFT' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return null;end if;
 if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);return null;end if;
 select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;select p.languages into languages from private.ai_policy p;
 update public.ai_jobs set dispatched_at=now() where id=j.id;
 return jsonb_build_object('snapshot',snapshot,'model',j.model,'languages',languages,'input_version',j.input_version);
end;$$;
create or replace function public.worker_finish_analysis(p_job uuid,p_lease uuid,p_result jsonb,p_tokens integer,p_latency integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;l public.leads;result public.ai_analyses;snapshot jsonb;e jsonb;fresh text;
begin
 perform private.require_worker();if p_request_id is null or p_tokens is null or p_tokens not between 0 and 250000 or p_latency is null or p_latency not between 0 and 90000 or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>48000 or p_result->>'rubric_version' is distinct from 'proposed-1' or jsonb_typeof(p_result->'score') is distinct from 'number' or (p_result->>'score')::numeric not between 0 and 100 or p_result->'analysis'->>'schema_version' is distinct from 'analysis-1' or jsonb_typeof(p_result->'analysis'->'field_evidence') is distinct from 'array' then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'ANALYSIS' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update public.ai_jobs set observed_tokens=observed_tokens+p_tokens where id=j.id returning * into j;
 if not private.analysis_allowed(j) then return private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);end if;
 select * into l from public.leads where tenant_id=j.tenant_id and id=j.lead_id for update;select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;
 for e in select value from jsonb_array_elements(p_result->'analysis'->'field_evidence') loop
  if not exists(select 1 from jsonb_array_elements(snapshot->'messages') m where m->>'id'=e->>'message_id' and m->>'version'=e->>'message_version' and char_length(e->>'excerpt') between 1 and 240 and strpos(m->>'body',e->>'excerpt')>0) then raise exception 'INVALID_EVIDENCE';end if;
 end loop;
 fresh:=case when l.context_version=j.input_version then 'CURRENT' else 'STALE' end;
 insert into public.ai_analyses(tenant_id,lead_id,job_id,input_version,freshness,result,model,prompt_version,schema_version,rubric_version,observed_tokens,latency_ms) values(j.tenant_id,j.lead_id,j.id,j.input_version,fresh,p_result,j.model,j.prompt_version,j.schema_version,'proposed-1',j.observed_tokens,p_latency) returning * into result;
 if fresh='CURRENT' then update public.leads set current_analysis_id=result.id where tenant_id=j.tenant_id and id=j.lead_id;end if;
 perform private.end_analysis(j.id,'SUCCEEDED',null,p_request_id);
 if fresh='CURRENT' then insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_READY',j.id,j.lead_id,'analysis-ready:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;end if;
 return jsonb_build_object('state','SUCCEEDED','freshness',fresh,'analysis_id',result.id);
end;$$;
create or replace function private.end_analysis(p_job uuid,p_state text,p_code text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;settled text;
begin
 select * into j from public.ai_jobs where id=p_job for update;
 settled:=case when j.uncertain_usage then 'RECONCILE' when j.observed_tokens>0 then 'CONSUMED' else 'RELEASED' end;
 if j.usage_state='RESERVED' and settled='RELEASED' then update private.ai_usage_windows set operations=operations-1 where tenant_id=j.tenant_id and (kind='DAY' and period_at=j.day_at or kind='MONTH' and period_at=j.month_at);end if;
 update public.ai_jobs set state=p_state,failure_code=p_code,usage_state=case when usage_state='RESERVED' then settled else usage_state end,lease_token=null,lease_until=null,completed_at=now(),reserved_tokens=case when settled='RECONCILE' then greatest(0,reserved_tokens-observed_tokens) else 0 end,version=version+1 where id=j.id returning * into j;
 delete from private.ai_context where job_id=j.id;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(j.tenant_id,j.lead_id,null,case when j.kind='DRAFT' then 'DRAFT_' else 'ANALYSIS_' end||p_state,p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'failure_code',p_code,'usage_state',j.usage_state));
 if p_state='FAILED' and private.analysis_allowed(j) and exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then
  insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_FAILED',j.id,j.lead_id,'analysis-failed:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;
 end if;
 return jsonb_build_object('state',j.state,'usage_state',j.usage_state);
end;$$;
create function public.worker_set_draft_policy(p_enabled boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.draft_policy;
begin perform private.require_worker();if p_enabled is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select * into p from private.draft_policy for update;if p.enabled is distinct from p_enabled then update private.draft_policy set enabled=p_enabled,version=version+1 returning * into p;insert into private.ai_policy_events(version,enabled,request_id) values(p.version,p.enabled,p_request_id);end if;return jsonb_build_object('enabled',p.enabled,'version',p.version);end;$$;
create function public.worker_finish_draft(p_job uuid,p_lease uuid,p_result jsonb,p_tokens integer,p_latency integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;l public.leads;d public.reply_drafts;snapshot jsonb;e jsonb;fresh text;safety jsonb;review_state text;
begin
 perform private.require_worker();if p_request_id is null or p_tokens is null or p_tokens not between 0 and 250000 or p_latency is null or p_latency not between 0 and 90000 or jsonb_typeof(p_result) is distinct from 'object' or p_result->>'schema_version' is distinct from 'draft-1' or jsonb_typeof(p_result->'text') is distinct from 'string' or char_length(trim(p_result->>'text')) not between 1 and 5000 or p_result->>'language' is null or p_result->>'language' not in ('en','ar') or p_result->>'tone' is null or p_result->>'tone' not in ('PROFESSIONAL','FRIENDLY') or jsonb_typeof(p_result->'outline'->'evidence') is distinct from 'array' then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'DRAFT' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update public.ai_jobs set observed_tokens=observed_tokens+p_tokens where id=j.id returning * into j;
 if not private.analysis_allowed(j) then return private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);end if;
 select * into l from public.leads where tenant_id=j.tenant_id and id=j.lead_id for update;select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;
 if p_result->>'language' is distinct from snapshot->'draft_options'->>'language' or p_result->>'tone' is distinct from snapshot->'draft_options'->>'tone' then raise exception 'INVALID_EVIDENCE';end if;
 for e in select value from jsonb_array_elements(p_result->'outline'->'evidence') loop if not exists(select 1 from jsonb_array_elements(snapshot->'messages') m where m->>'id'=e->>'message_id' and m->>'version'=e->>'message_version' and char_length(e->>'excerpt') between 1 and 240 and strpos(m->>'body',e->>'excerpt')>0) then raise exception 'INVALID_EVIDENCE';end if;end loop;
 fresh:=case when l.context_version=j.input_version then 'CURRENT' else 'STALE' end;safety:=private.draft_safety(p_result->>'text');review_state:=case when fresh='STALE' then 'SUPERSEDED' when safety<>'[]'::jsonb then 'WITHHELD' else 'GENERATED' end;
 if fresh='CURRENT' then update public.reply_drafts set state='SUPERSEDED',version=version+1,approved_by=null,approved_at=null where tenant_id=j.tenant_id and lead_id=j.lead_id and state in ('GENERATED','EDITED','APPROVED','COPIED');end if;
 insert into public.reply_drafts(tenant_id,lead_id,job_id,input_version,state,freshness,original_text,working_text,language,tone,safety_flags,outline,model,prompt_version,schema_version,observed_tokens,latency_ms) values(j.tenant_id,j.lead_id,j.id,j.input_version,review_state,fresh,p_result->>'text',p_result->>'text',p_result->>'language',p_result->>'tone',safety,p_result->'outline',j.model,j.prompt_version,j.schema_version,j.observed_tokens,p_latency) returning * into d;
 perform private.end_analysis(j.id,'SUCCEEDED',null,p_request_id);
 insert into public.activity_events(tenant_id,lead_id,event_type,request_id,details) values(j.tenant_id,j.lead_id,'DRAFT_'||review_state,p_request_id,jsonb_build_object('draft_id',d.id,'input_version',d.input_version));
 if fresh='CURRENT' then insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_READY',j.id,j.lead_id,'draft-ready:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;end if;
 return jsonb_build_object('state','SUCCEEDED','freshness',fresh,'draft_id',d.id,'review_state',review_state);
end;$$;
create function private.invalidate_draft_review() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.context_version<>old.context_version then update public.reply_drafts set state='SUPERSEDED',freshness='STALE',version=version+1,approved_by=null,approved_at=null where tenant_id=new.tenant_id and lead_id=new.id and state in ('GENERATED','EDITED','APPROVED','COPIED','WITHHELD');
 elsif new.assignment_version<>old.assignment_version or new.archived_at is distinct from old.archived_at or new.do_not_contact is distinct from old.do_not_contact or (new.status is distinct from old.status and (new.status in ('WON','LOST') or old.status in ('WON','LOST'))) then update public.reply_drafts set state='EDITED',version=version+1,approved_by=null,approved_at=null where tenant_id=new.tenant_id and lead_id=new.id and state in ('APPROVED','COPIED');end if;return new;
end;$$;
create trigger invalidate_draft_review after update on public.leads for each row execute function private.invalidate_draft_review();
create function private.draft_outreach(l public.leads) returns void language plpgsql security definer set search_path='' as $$
begin if l.archived_at is not null or l.status in ('WON','LOST') or l.do_not_contact then raise exception 'CONTACT_BLOCKED';end if;
 if not exists(select 1 from public.agencies a cross join private.ai_policy p cross join private.draft_policy dp where a.id=l.tenant_id and a.processing_approved and a.ai_enabled and p.enabled and dp.enabled) then raise exception 'DRAFT_DISABLED';end if;end;$$;
create or replace function private.notice_current(n public.notifications) returns boolean language plpgsql stable security definer set search_path='' as $$
declare member public.memberships;lead public.leads;task public.follow_ups;
begin
 if not private.recipient_access(n.tenant_id,n.recipient_id,n.lead_id,n.task_id) then return false;end if;
 select * into member from public.memberships where tenant_id=n.tenant_id and id=n.recipient_id and active;
 if n.type='INVITE_ACCEPTED' then return member.role in ('OWNER','ADMIN') and exists(select 1 from public.memberships m where m.tenant_id=n.tenant_id and m.id=n.resource_id and m.active and (member.role='OWNER' or m.role='AGENT'));end if;
 if n.lead_id is null then return false;end if;
 select * into lead from public.leads where tenant_id=n.tenant_id and id=n.lead_id;
 if not found or lead.archived_at is not null or lead.status in ('WON','LOST') then return false;end if;
 if n.type='LEAD_ASSIGNED' then return lead.assignment_version=n.assignment_version and (lead.assignee_id=n.recipient_id or lead.assignee_id is null and member.role in ('OWNER','ADMIN'));end if;
 if n.type='MANAGER_REVIEW' then return lead.duplicate_review and lead.review_version=n.review_version and member.role in ('OWNER','ADMIN');end if;
 if n.type='FOLLOW_UP_DUE' then
  select * into task from public.follow_ups where tenant_id=n.tenant_id and id=n.task_id and lead_id=n.lead_id;
  return found and task.state='OPEN' and task.schedule_version=n.schedule_version and task.due_at<=now() and (not lead.do_not_contact or task.type='INTERNAL') and (task.assignee_id=n.recipient_id or task.assignee_id is null and member.role in ('OWNER','ADMIN'));
 end if;
 if n.type in ('AI_READY','AI_FAILED') then
  return lead.context_version=n.input_version and exists(select 1 from public.ai_jobs j where j.tenant_id=n.tenant_id and j.lead_id=n.lead_id and j.id=n.resource_id and j.requester_member_id=n.recipient_id and j.input_version=n.input_version and (j.kind='ANALYSIS' or not lead.do_not_contact) and (n.type='AI_READY' and j.state='SUCCEEDED' and exists(select 1 from public.ai_analyses a where a.job_id=j.id and a.id=lead.current_analysis_id) or n.type='AI_READY' and j.state='SUCCEEDED' and j.kind='DRAFT' and exists(select 1 from public.reply_drafts d where d.job_id=j.id and d.input_version=lead.context_version and d.freshness='CURRENT' and d.state in ('GENERATED','EDITED','APPROVED','COPIED','WITHHELD')) or n.type='AI_FAILED' and j.state='FAILED'));
 end if;
 return false;
end; $$;
create function public.mutate_draft(p_tenant uuid,p_draft uuid,p_action text,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;d public.reply_drafts;r private.api_requests;receipt private.draft_copy_receipts;result jsonb;flags jsonb;feedback_id uuid;message jsonb;op text:='draft-action:'||p_tenant||':'||p_draft||':'||p_action;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if p_action is null or p_action not in ('EDIT','APPROVE','REJECT','FEEDBACK','COPY_AUTH','COPY_DONE','LOG_EXTERNAL') or p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED';end if;
 perform private.team_payload(p_payload,case p_action when 'EDIT' then array['expected_version','text'] when 'APPROVE' then array['expected_version','acknowledged'] when 'REJECT' then array['expected_version','reason'] when 'FEEDBACK' then array['expected_version','category','comment'] when 'COPY_AUTH' then array['expected_version'] when 'COPY_DONE' then array['expected_version','copy_token'] when 'LOG_EXTERNAL' then array['expected_version','expected_lead_version','body','occurred_at','sent_confirmed'] end);
 select * into l from public.leads where tenant_id=p_tenant and id=(select x.lead_id from public.reply_drafts x where x.tenant_id=p_tenant and x.id=p_draft) and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into d from public.reply_drafts where tenant_id=p_tenant and id=p_draft for update;
 if p_action in ('APPROVE','COPY_AUTH','COPY_DONE') then perform private.draft_outreach(l);if d.input_version<>l.context_version or d.freshness<>'CURRENT' then raise exception 'DRAFT_STALE';end if;end if;
 if p_action in ('COPY_AUTH','COPY_DONE') then
  if d.state not in ('APPROVED','COPIED') or d.safety_flags<>'[]'::jsonb or d.approved_by is distinct from m.id or d.approved_member_version is distinct from m.version or d.approved_assignment_version is distinct from l.assignment_version or d.approved_content_version is distinct from d.content_version or d.approved_input_version is distinct from l.context_version then raise exception 'DRAFT_REVIEW_REQUIRED';end if;
 end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;
 if found then
  if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if p_action='COPY_AUTH' and not exists(select 1 from private.draft_copy_receipts c where c.token=(r.response->>'copy_token')::uuid and c.actor_id=m.user_id and c.content_version=d.content_version and c.expires_at>now()) then raise exception 'COPY_EXPIRED';end if;
  return r.response;
 end if;
 if p_payload->>'expected_version' is distinct from d.version::text then raise exception 'VERSION_CONFLICT';end if;
 if p_action='EDIT' then
  if d.input_version<>l.context_version or d.state='SUPERSEDED' then raise exception 'DRAFT_STALE';end if;if d.state='REJECTED' then raise exception 'STATE_CONFLICT';end if;
  if jsonb_typeof(p_payload->'text') is distinct from 'string' or char_length(trim(p_payload->>'text')) not between 1 and 5000 then raise exception 'VALIDATION_FAILED';end if;
  flags:=private.draft_safety(p_payload->>'text');update public.reply_drafts set working_text=trim(p_payload->>'text'),state=case when flags='[]'::jsonb then 'EDITED' else 'WITHHELD' end,safety_flags=flags,content_version=content_version+1,version=version+1,approved_by=null,approved_at=null,updated_at=now() where id=d.id returning * into d;result:=to_jsonb(d);
 elsif p_action='APPROVE' then
  if p_payload->'acknowledged' is distinct from 'true'::jsonb then raise exception 'DRAFT_REVIEW_REQUIRED';end if;
  if d.state not in ('GENERATED','EDITED','APPROVED','COPIED') or d.safety_flags<>'[]'::jsonb or private.draft_safety(d.working_text)<>'[]'::jsonb then raise exception 'DRAFT_UNSAFE';end if;
  update public.reply_drafts set state='APPROVED',approved_by=m.id,approved_member_version=m.version,approved_assignment_version=l.assignment_version,approved_content_version=content_version,approved_input_version=l.context_version,approved_at=now(),version=version+1,updated_at=now() where id=d.id returning * into d;result:=to_jsonb(d);
 elsif p_action='REJECT' then
  if jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;if d.state='REJECTED' then raise exception 'STATE_CONFLICT';end if;
  update public.reply_drafts set state='REJECTED',rejection_reason=trim(p_payload->>'reason'),approved_by=null,approved_at=null,version=version+1,updated_at=now() where id=d.id returning * into d;result:=to_jsonb(d);
 elsif p_action='FEEDBACK' then
  if p_payload->>'category' is null or p_payload->>'category' not in ('USEFUL','INCORRECT','UNSAFE','UNHELPFUL') or jsonb_typeof(p_payload->'comment') is distinct from 'string' or char_length(p_payload->>'comment')>500 then raise exception 'VALIDATION_FAILED';end if;
  insert into public.draft_feedback(tenant_id,lead_id,draft_id,actor_id,content_version,category,comment) values(p_tenant,l.id,d.id,m.user_id,d.content_version,p_payload->>'category',trim(p_payload->>'comment')) returning id into feedback_id;
  if p_payload->>'category'='UNSAFE' then update public.reply_drafts set state=case when state='SUPERSEDED' then state else 'WITHHELD' end,safety_flags=jsonb_build_array('HUMAN_UNSAFE_FEEDBACK'),approved_by=null,approved_at=null,version=version+1,updated_at=now() where id=d.id returning * into d;end if;
  result:=jsonb_build_object('feedback_id',feedback_id,'draft',to_jsonb(d));
 elsif p_action='COPY_AUTH' then
  insert into private.draft_copy_receipts(tenant_id,draft_id,actor_id,content_version,draft_version) values(p_tenant,d.id,m.user_id,d.content_version,d.version) returning * into receipt;
  result:=jsonb_build_object('text',d.working_text,'copy_token',receipt.token,'expected_version',d.version,'expires_at',receipt.expires_at);
 elsif p_action='COPY_DONE' then
  if p_payload->>'copy_token' is null or p_payload->>'copy_token' !~ '^[0-9a-fA-F-]{36}$' then raise exception 'VALIDATION_FAILED';end if;
  select * into receipt from private.draft_copy_receipts where token=(p_payload->>'copy_token')::uuid and tenant_id=p_tenant and draft_id=d.id and actor_id=m.user_id for update;
  if not found or receipt.expires_at<=now() then raise exception 'COPY_EXPIRED';end if;if receipt.completed_at is not null then raise exception 'STATE_CONFLICT';end if;
  if receipt.content_version<>d.content_version or receipt.draft_version<>d.version then raise exception 'VERSION_CONFLICT';end if;
  update private.draft_copy_receipts set completed_at=now() where token=receipt.token;
  update public.reply_drafts set state='COPIED',version=version+1,updated_at=now() where id=d.id returning * into d;result:=jsonb_build_object('draft',to_jsonb(d),'copied',true);
 elsif p_action='LOG_EXTERNAL' then
  if p_payload->'sent_confirmed' is distinct from 'true'::jsonb or not exists(select 1 from private.draft_copy_receipts c where c.tenant_id=p_tenant and c.draft_id=d.id and c.actor_id=m.user_id and c.completed_at is not null) then raise exception 'EXTERNAL_LOG_CONFIRMATION_REQUIRED';end if;
  message:=public.add_lead_message(p_tenant,l.id,jsonb_build_object('direction','OUTBOUND','body',p_payload->'body','occurred_at',p_payload->'occurred_at','expected_version',p_payload->'expected_lead_version'),p_key,p_request_id);
  result:=jsonb_build_object('message',message,'draft_id',d.id);
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,l.id,m.user_id,case when p_action='COPY_AUTH' then 'DRAFT_COPY_AUTHORIZED' when p_action='COPY_DONE' then 'DRAFT_COPIED' when p_action='LOG_EXTERNAL' then 'DRAFT_EXTERNAL_LOGGED' else 'DRAFT_'||p_action end,p_request_id,p_payload->>'reason',jsonb_build_object('draft_id',d.id,'draft_version',d.version,'content_version',d.content_version,'input_version',d.input_version,'feedback_category',p_payload->>'category'));
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create function public.worker_draft_metrics() returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.require_worker();return jsonb_build_object('queued',(select count(*) from public.ai_jobs where kind='DRAFT' and state='QUEUED'),'failed',(select count(*) from public.ai_jobs where kind='DRAFT' and state='FAILED'),'withheld',(select count(*) from public.reply_drafts where state='WITHHELD'));end;$$;
create function public.draft_feedback_summary(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);
begin if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 return jsonb_build_object('total',(select count(*) from public.draft_feedback where tenant_id=p_tenant),'categories',coalesce((select jsonb_object_agg(category,n) from (select category,count(*) n from public.draft_feedback where tenant_id=p_tenant group by category) grouped),'{}'::jsonb));end;$$;
revoke all on function private.draft_safety(text),private.invalidate_draft_review(),private.draft_outreach(public.leads) from public,anon,authenticated;
revoke all on function public.submit_draft(uuid,uuid,integer,jsonb,uuid,uuid),public.mutate_draft(uuid,uuid,text,jsonb,uuid,uuid),public.draft_feedback_summary(uuid) from public,anon;
grant execute on function public.submit_draft(uuid,uuid,integer,jsonb,uuid,uuid),public.mutate_draft(uuid,uuid,text,jsonb,uuid,uuid),public.draft_feedback_summary(uuid) to authenticated;
revoke all on function public.worker_set_draft_policy(boolean,uuid),public.worker_claim_draft(uuid),public.worker_prepare_draft(uuid,uuid,uuid),public.worker_finish_draft(uuid,uuid,jsonb,integer,integer,uuid),public.worker_draft_metrics() from public,anon,authenticated;
grant execute on function public.worker_set_draft_policy(boolean,uuid),public.worker_claim_draft(uuid),public.worker_prepare_draft(uuid,uuid,uuid),public.worker_finish_draft(uuid,uuid,jsonb,integer,integer,uuid),public.worker_draft_metrics() to service_role;

-- Source: 202610070013_dashboard.sql
-- Every metric and its pages use these identical, explicitly authorized rows.
create function private.dashboard_window(p_tenant uuid,p_from date,p_to date,p_as_of timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);tz text;f date;t date;
begin
 select timezone into tz from public.agencies where id=p_tenant;
 if (p_from is null)<>(p_to is null) or p_as_of is null or p_as_of>clock_timestamp()+interval '5 seconds' or p_as_of<clock_timestamp()-interval '24 hours' then raise exception 'VALIDATION_FAILED';end if;
 t:=coalesce(p_to,(p_as_of at time zone tz)::date);f:=coalesce(p_from,t-29);
 if f>t or t-f>365 or f<date '1970-01-01' or t>date '9998-12-31' then raise exception 'VALIDATION_FAILED';end if;
 return jsonb_build_object('from',f,'to',t,'timezone',tz,'start_at',f::timestamp at time zone tz,'end_at',(t+1)::timestamp at time zone tz,'as_of',p_as_of,'scope',case when m.role='AGENT' then 'CURRENT_ASSIGNED' else 'AGENCY' end,'manager',m.role in ('OWNER','ADMIN'));
end;$$;
create function private.dashboard_items(p_tenant uuid,p_metric text,p_start timestamptz,p_end timestamptz,p_as_of timestamptz)
returns table(row_id uuid,sort_at timestamptz,entity text,payload jsonb) language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);
begin
 if p_metric not in ('TOTAL','QUALIFIED','WON','UNASSIGNED','DUE','CONTACTED_IN_COHORT','STAGE_NEW','STAGE_CONTACTED','STAGE_QUALIFIED','STAGE_FOLLOW_UP','STAGE_WON','STAGE_LOST') or p_metric is null then raise exception 'VALIDATION_FAILED';end if;
 if p_metric='UNASSIGNED' and m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 if p_metric='DUE' then
  return query select f.id,f.due_at,'TASK'::text,to_jsonb(f)||jsonb_build_object('lead_name',l.full_name,'lead_status',l.status)
  from public.follow_ups f join public.leads l on l.tenant_id=f.tenant_id and l.id=f.lead_id
  where l.tenant_id=p_tenant and l.archived_at is null and f.state='OPEN' and f.due_at<=p_as_of
  and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id and f.assignee_id=m.id);
 else
  return query select l.id,l.created_at,'LEAD'::text,to_jsonb(l)||case when p_metric='CONTACTED_IN_COHORT' then jsonb_build_object('first_logged_contact_at',contact.first_at,'contact_latency_seconds',extract(epoch from contact.first_at-l.created_at)) else '{}'::jsonb end
  from public.leads l left join lateral(select min(msg.occurred_at) first_at from public.messages msg where msg.tenant_id=l.tenant_id and msg.lead_id=l.id and msg.direction='OUTBOUND' and msg.delivery_status='USER_REPORTED' and msg.occurred_at>=l.created_at and msg.occurred_at<=p_as_of) contact on p_metric='CONTACTED_IN_COHORT'
  where l.tenant_id=p_tenant and l.archived_at is null and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
  and case
   when p_metric='WON' then l.status='WON' and l.won_at>=p_start and l.won_at<p_end
   when p_metric='UNASSIGNED' then l.assignee_id is null and l.status not in ('WON','LOST')
   else l.created_at>=p_start and l.created_at<p_end and case when p_metric='QUALIFIED' then l.status='QUALIFIED' when p_metric='CONTACTED_IN_COHORT' then contact.first_at is not null when p_metric like 'STAGE_%' then l.status::text=substr(p_metric,7) else true end
  end;
 end if;
end;$$;
create function public.dashboard_summary(p_tenant uuid,p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w jsonb:=private.dashboard_window(p_tenant,p_from,p_to,statement_timestamp());s timestamptz:=(w->>'start_at')::timestamptz;e timestamptz:=(w->>'end_at')::timestamptz;a timestamptz:=(w->>'as_of')::timestamptz;cohort jsonb;pipeline jsonb;total bigint;qualified bigint;won bigint;due bigint;unassigned bigint;contacted bigint;median_seconds numeric;
begin
 select count(*),count(*) filter(where payload->>'status'='QUALIFIED'),coalesce(jsonb_agg(jsonb_build_object('status',payload->'status')),'[]') into total,qualified,cohort from private.dashboard_items(p_tenant,'TOTAL',s,e,a);
 select jsonb_object_agg(stage,cnt) into pipeline from (select status::text stage,(select count(*) from jsonb_array_elements(cohort) c where c->>'status'=status::text) cnt from unnest(enum_range(null::public.lead_status)) status) stages;
 select count(*) into won from private.dashboard_items(p_tenant,'WON',s,e,a);select count(*) into due from private.dashboard_items(p_tenant,'DUE',s,e,a);
 if (w->>'manager')::boolean then select count(*) into unassigned from private.dashboard_items(p_tenant,'UNASSIGNED',s,e,a);end if;
 select count(*),percentile_cont(0.5) within group(order by (payload->>'contact_latency_seconds')::numeric) into contacted,median_seconds from private.dashboard_items(p_tenant,'CONTACTED_IN_COHORT',s,e,a);
 return jsonb_build_object('window',w,'metrics',jsonb_build_object('total',total,'qualified',qualified,'won',won,'due',due,'unassigned',unassigned),'pipeline',pipeline,'contact',jsonb_build_object('sample_count',contacted,'without_logged_contact',total-contacted,'median_seconds',median_seconds));
end;$$;
create function public.dashboard_drilldown(p_tenant uuid,p_metric text,p_from date,p_to date,p_as_of timestamptz,p_limit integer default 26,p_cursor_time timestamptz default null,p_cursor_id uuid default null)
returns table(row_id uuid,sort_at timestamptz,entity text,payload jsonb) language plpgsql stable security definer set search_path='' as $$
declare w jsonb:=private.dashboard_window(p_tenant,p_from,p_to,p_as_of);
begin
 if p_limit is null or p_limit not between 1 and 101 or (p_cursor_time is null)<>(p_cursor_id is null) then raise exception 'VALIDATION_FAILED';end if;
 return query select i.* from private.dashboard_items(p_tenant,p_metric,(w->>'start_at')::timestamptz,(w->>'end_at')::timestamptz,p_as_of) i
 where p_cursor_time is null or (i.sort_at,i.row_id)<(p_cursor_time,p_cursor_id) order by i.sort_at desc,i.row_id desc limit p_limit;
end;$$;
revoke all on function private.dashboard_window(uuid,date,date,timestamptz),private.dashboard_items(uuid,text,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.dashboard_summary(uuid,date,date),public.dashboard_drilldown(uuid,text,date,date,timestamptz,integer,timestamptz,uuid) from public,anon;
grant execute on function public.dashboard_summary(uuid,date,date),public.dashboard_drilldown(uuid,text,date,date,timestamptz,integer,timestamptz,uuid) to authenticated;
create index dashboard_won on public.leads(tenant_id,won_at,id) where archived_at is null and status='WON';
create index dashboard_first_contact on public.messages(tenant_id,lead_id,occurred_at) where direction='OUTBOUND' and delivery_status='USER_REPORTED';

-- Source: 202610070014_hardening.sql
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

-- Source: 202610070015_intake_key_rotation.sql
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

-- Source: 202610070016_invitation_key_rotation.sql
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

-- Source: 202610070017_intake_signing_roots.sql
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

-- Source: 202610080018_agency_operations.sql
-- Cookie-user projection only: current verified managers, one tenant, no job/customer payloads.
create function public.agency_operations_snapshot(p_tenant uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);due_n bigint;due_lag integer;out_pending bigint;out_running bigint;out_failed bigint;out_expired bigint;out_lag integer;ai_queued bigint;ai_running bigint;ai_failed bigint;ai_expired bigint;ai_lag integer;reconcile bigint;alerts jsonb:='[]';
begin
 perform private.verified_actor();if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 select count(*),coalesce(greatest(0,extract(epoch from now()-min(d.due_at)))::integer,0) into due_n,due_lag from private.due_candidates d
 where d.tenant_id=p_tenant and not exists(select 1 from public.notifications n where n.tenant_id=d.tenant_id and n.recipient_id=d.recipient_id and n.dedupe_key=d.notice_key);
 select count(*) filter(where state='PENDING'),count(*) filter(where state='RUNNING'),count(*) filter(where state='FAILED'),count(*) filter(where state='RUNNING' and lease_until<=now()),coalesce(greatest(0,extract(epoch from now()-min(created_at) filter(where state in ('PENDING','RUNNING'))))::integer,0)
 into out_pending,out_running,out_failed,out_expired,out_lag from private.outbox_events where tenant_id=p_tenant;
 select count(*) filter(where state='QUEUED'),count(*) filter(where state='RUNNING'),count(*) filter(where state='FAILED'),count(*) filter(where state='RUNNING' and lease_until<=now()),coalesce(greatest(0,extract(epoch from now()-min(requested_at) filter(where state in ('QUEUED','RUNNING'))))::integer,0),count(*) filter(where usage_state='RECONCILE')
 into ai_queued,ai_running,ai_failed,ai_expired,ai_lag,reconcile from public.ai_jobs where tenant_id=p_tenant;
 if due_lag>900 then alerts:=alerts||jsonb_build_array('REMINDERS_DELAYED');end if;
 if out_lag>900 then alerts:=alerts||jsonb_build_array('NOTIFICATION_QUEUE_DELAYED');end if;
 if ai_lag>900 then alerts:=alerts||jsonb_build_array('AI_QUEUE_DELAYED');end if;
 if out_failed>0 then alerts:=alerts||jsonb_build_array('FAILED_NOTIFICATION_JOBS');end if;
 if ai_failed>0 then alerts:=alerts||jsonb_build_array('FAILED_AI_JOBS');end if;
 if reconcile>0 then alerts:=alerts||jsonb_build_array('AI_USAGE_RECONCILIATION');end if;
 if out_expired+ai_expired>0 then alerts:=alerts||jsonb_build_array('EXPIRED_WORKER_LEASES');end if;
 return jsonb_build_object('captured_at',statement_timestamp(),'lag_alert_seconds',900,
 'reminders',jsonb_build_object('awaiting_creation',due_n,'oldest_due_seconds',due_lag),
 'notifications',jsonb_build_object('pending',out_pending,'running',out_running,'failed',out_failed,'expired_leases',out_expired,'oldest_pending_seconds',out_lag),
 'ai',jsonb_build_object('queued',ai_queued,'running',ai_running,'failed',ai_failed,'expired_leases',ai_expired,'oldest_pending_seconds',ai_lag,'reconciliation',reconcile),
 'alerts',alerts,'cost_amount',null,'scheduler_verified',false);
end;$$;
revoke all on function public.agency_operations_snapshot(uuid) from public,anon,service_role;
grant execute on function public.agency_operations_snapshot(uuid) to authenticated;
create index outbox_tenant_operations on private.outbox_events(tenant_id,state,created_at);
create index ai_tenant_operations on public.ai_jobs(tenant_id,state,requested_at);

-- Source: 202610080019_platform_health.sql
-- Platform operator only. A statement snapshot never claims cron or provider delivery.
create or replace function public.worker_health_snapshot() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare captured timestamptz:=statement_timestamp();due_lag bigint;outbox_lag bigint;ai_lag bigint;outbox_pending bigint;outbox_failed bigint;outbox_expired bigint;ai_pending bigint;ai_failed bigint;ai_expired bigint;reconcile bigint;reserved bigint;v_tokens bigint;privacy_pending bigint;
begin
 perform private.require_worker();
 -- Match worker eligibility, but use this statement's cutoff instead of the worker view's transaction clock.
 select coalesce(greatest(0,extract(epoch from captured-min(f.due_at)))::bigint,0) into due_lag
 from public.follow_ups f join public.leads l on l.tenant_id=f.tenant_id and l.id=f.lead_id
 join public.memberships m on m.tenant_id=f.tenant_id and m.active
 where f.state='OPEN' and f.due_at<=captured and l.archived_at is null and l.status not in ('WON','LOST') and (not l.do_not_contact or f.type='INTERNAL')
 and (f.assignee_id=m.id or f.assignee_id is null and m.role in ('OWNER','ADMIN')) and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
 and exists(select 1 from auth.users u where u.id=m.user_id and u.email_confirmed_at is not null)
 and not exists(select 1 from public.notifications n where n.tenant_id=f.tenant_id and n.recipient_id=m.id and n.dedupe_key='due:'||f.id::text||':'||f.schedule_version::text);
 select count(*) filter(where state in ('PENDING','RUNNING')),coalesce(greatest(0,extract(epoch from captured-min(created_at) filter(where state in ('PENDING','RUNNING'))))::bigint,0),count(*) filter(where state='FAILED'),count(*) filter(where state='RUNNING' and lease_until<=captured)
 into outbox_pending,outbox_lag,outbox_failed,outbox_expired from private.outbox_events;
 select count(*) filter(where state in ('QUEUED','RUNNING')),coalesce(greatest(0,extract(epoch from captured-min(requested_at) filter(where state in ('QUEUED','RUNNING'))))::bigint,0),count(*) filter(where state='FAILED'),count(*) filter(where state='RUNNING' and lease_until<=captured),count(*) filter(where usage_state='RECONCILE'),count(*) filter(where usage_state='RESERVED'),coalesce(sum(observed_tokens) filter(where month_at=date_trunc('month',captured at time zone 'UTC')::date),0)
 into ai_pending,ai_lag,ai_failed,ai_expired,reconcile,reserved,v_tokens from public.ai_jobs;
 select count(*) into privacy_pending from public.privacy_cases where state<>'WITHDRAWN';
 return jsonb_build_object('database','REACHABLE','captured_at',captured,'lag_alert_seconds',900,
 'due_lag_seconds',due_lag,'outbox_lag_seconds',outbox_lag,'ai_lag_seconds',ai_lag,
 'outbox_pending',outbox_pending,'outbox_failed',outbox_failed,'outbox_expired_leases',outbox_expired,
 'ai_pending',ai_pending,'ai_failed',ai_failed,'ai_expired_leases',ai_expired,
 'reserved_operations',reserved,'reconcile_operations',reconcile,'observed_tokens_month',v_tokens,
 'cost_amount',null,'privacy_pending',privacy_pending,'privacy_execution_available',false,'scheduler_verified',false,
 'alert',due_lag>900 or outbox_lag>900 or ai_lag>900 or outbox_failed>0 or ai_failed>0 or reconcile>0 or outbox_expired>0 or ai_expired>0);
end;$$;
revoke all on function public.worker_health_snapshot() from public,anon,authenticated;
grant execute on function public.worker_health_snapshot() to service_role;

-- Source: 202610080020_ai_attempt_tracking.sql
-- Prepared-call correlation only: not proof of dispatch, exactly-once calls or billing.
create table private.ai_provider_attempts(
 job_id uuid not null references public.ai_jobs(id),claim_attempt integer not null check(claim_attempt between 1 and 3),
 provider_request_id uuid not null default gen_random_uuid() unique,prepared_at timestamptz not null default statement_timestamp(),
 primary key(job_id,claim_attempt)
);
alter table private.ai_provider_attempts enable row level security;
revoke all on private.ai_provider_attempts from public,anon,authenticated,service_role;

alter function public.worker_prepare_analysis(uuid,uuid,uuid) set schema private;
alter function private.worker_prepare_analysis(uuid,uuid,uuid) rename to prepare_analysis_020_core;
alter function public.worker_prepare_draft(uuid,uuid,uuid) set schema private;
alter function private.worker_prepare_draft(uuid,uuid,uuid) rename to prepare_draft_020_core;
revoke all on function private.prepare_analysis_020_core(uuid,uuid,uuid),private.prepare_draft_020_core(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function private.record_ai_provider_attempt(p_job uuid) returns uuid language plpgsql set search_path='' as $$
declare request_id uuid;attempt integer;
begin
 -- Called only after the original prepare core has locked and authorized this lease.
 select attempts into attempt from public.ai_jobs where id=p_job;
 insert into private.ai_provider_attempts(job_id,claim_attempt) values(p_job,attempt) on conflict(job_id,claim_attempt) do nothing;
 select provider_request_id into request_id from private.ai_provider_attempts where job_id=p_job and claim_attempt=attempt;
 return request_id;
end;$$;
revoke all on function private.record_ai_provider_attempt(uuid) from public,anon,authenticated,service_role;

create function public.worker_prepare_analysis(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare context jsonb;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 context:=private.prepare_analysis_020_core(p_job,p_lease,p_request_id);
 if context is null then return null;end if;
 return context||jsonb_build_object('provider_request_id',private.record_ai_provider_attempt(p_job));
end;$$;
create function public.worker_prepare_draft(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare context jsonb;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 context:=private.prepare_draft_020_core(p_job,p_lease,p_request_id);
 if context is null then return null;end if;
 return context||jsonb_build_object('provider_request_id',private.record_ai_provider_attempt(p_job));
end;$$;
revoke all on function public.worker_prepare_analysis(uuid,uuid,uuid),public.worker_prepare_draft(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.worker_prepare_analysis(uuid,uuid,uuid),public.worker_prepare_draft(uuid,uuid,uuid) to service_role;

create function public.worker_ai_attempt_diagnostics(p_job uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare j public.ai_jobs;attempts jsonb;tracked integer;
begin
 perform private.require_worker();if p_job is null then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then raise exception 'NOT_FOUND';end if;
 select count(*)::integer,coalesce(jsonb_agg(jsonb_build_object('claim_attempt',claim_attempt,'provider_request_id',provider_request_id,'prepared_at',prepared_at) order by claim_attempt),'[]'::jsonb)
 into tracked,attempts from private.ai_provider_attempts where job_id=j.id;
 return jsonb_build_object('job_id',j.id,'kind',j.kind,'job_version',j.version,'state',j.state,'usage_state',j.usage_state,
 'uncertain_usage',j.uncertain_usage,'observed_tokens',j.observed_tokens,'reserved_tokens',j.reserved_tokens,
 'claim_attempts',j.attempts,'claims_without_prepare_record',j.attempts-tracked,'attempts',attempts,
 'provider_usage_verified',false,'resolution_available',false);
end;$$;
revoke all on function public.worker_ai_attempt_diagnostics(uuid) from public,anon,authenticated;
grant execute on function public.worker_ai_attempt_diagnostics(uuid) to service_role;

-- Source: 202610100021_read_membership.sql
-- Read RPCs must work in PostgREST READ ONLY transactions.
-- Keep private.active_member and private.writer_member locks for mutations.
create function private.read_member(p_tenant uuid) returns public.memberships
language plpgsql stable security definer set search_path='' as $$
declare result public.memberships; actor uuid:=private.verified_actor();
begin
 select * into result from public.memberships m where m.tenant_id=p_tenant and m.user_id=actor and m.active;
 if not found then raise exception 'MEMBERSHIP_REQUIRED';end if;
 return result;
end;$$;
revoke all on function private.read_member(uuid) from public,anon,authenticated;

-- Retain signature, access checks, output and grants from 202610070013_dashboard.sql.
create or replace function private.dashboard_items(p_tenant uuid,p_metric text,p_start timestamptz,p_end timestamptz,p_as_of timestamptz)
returns table(row_id uuid,sort_at timestamptz,entity text,payload jsonb) language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);
begin
 if p_metric not in ('TOTAL','QUALIFIED','WON','UNASSIGNED','DUE','CONTACTED_IN_COHORT','STAGE_NEW','STAGE_CONTACTED','STAGE_QUALIFIED','STAGE_FOLLOW_UP','STAGE_WON','STAGE_LOST') or p_metric is null then raise exception 'VALIDATION_FAILED';end if;
 if p_metric='UNASSIGNED' and m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 if p_metric='DUE' then
  return query select f.id,f.due_at,'TASK'::text,to_jsonb(f)||jsonb_build_object('lead_name',l.full_name,'lead_status',l.status)
  from public.follow_ups f join public.leads l on l.tenant_id=f.tenant_id and l.id=f.lead_id
  where l.tenant_id=p_tenant and l.archived_at is null and f.state='OPEN' and f.due_at<=p_as_of
  and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id and f.assignee_id=m.id);
 else
  return query select l.id,l.created_at,'LEAD'::text,to_jsonb(l)||case when p_metric='CONTACTED_IN_COHORT' then jsonb_build_object('first_logged_contact_at',contact.first_at,'contact_latency_seconds',extract(epoch from contact.first_at-l.created_at)) else '{}'::jsonb end
  from public.leads l left join lateral(select min(msg.occurred_at) first_at from public.messages msg where msg.tenant_id=l.tenant_id and msg.lead_id=l.id and msg.direction='OUTBOUND' and msg.delivery_status='USER_REPORTED' and msg.occurred_at>=l.created_at and msg.occurred_at<=p_as_of) contact on p_metric='CONTACTED_IN_COHORT'
  where l.tenant_id=p_tenant and l.archived_at is null and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
  and case
   when p_metric='WON' then l.status='WON' and l.won_at>=p_start and l.won_at<p_end
   when p_metric='UNASSIGNED' then l.assignee_id is null and l.status not in ('WON','LOST')
   else l.created_at>=p_start and l.created_at<p_end and case when p_metric='QUALIFIED' then l.status='QUALIFIED' when p_metric='CONTACTED_IN_COHORT' then contact.first_at is not null when p_metric like 'STAGE_%' then l.status::text=substr(p_metric,7) else true end
  end;
 end if;
end;$$;

-- Retain signature, access checks, output and grants from 202610070013_dashboard.sql.
create or replace function private.dashboard_window(p_tenant uuid,p_from date,p_to date,p_as_of timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);tz text;f date;t date;
begin
 select timezone into tz from public.agencies where id=p_tenant;
 if (p_from is null)<>(p_to is null) or p_as_of is null or p_as_of>clock_timestamp()+interval '5 seconds' or p_as_of<clock_timestamp()-interval '24 hours' then raise exception 'VALIDATION_FAILED';end if;
 t:=coalesce(p_to,(p_as_of at time zone tz)::date);f:=coalesce(p_from,t-29);
 if f>t or t-f>365 or f<date '1970-01-01' or t>date '9998-12-31' then raise exception 'VALIDATION_FAILED';end if;
 return jsonb_build_object('from',f,'to',t,'timezone',tz,'start_at',f::timestamp at time zone tz,'end_at',(t+1)::timestamp at time zone tz,'as_of',p_as_of,'scope',case when m.role='AGENT' then 'CURRENT_ASSIGNED' else 'AGENCY' end,'manager',m.role in ('OWNER','ADMIN'));
end;$$;

-- Retain signature, access checks, output and grants from 202610080018_agency_operations.sql.
create or replace function public.agency_operations_snapshot(p_tenant uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);due_n bigint;due_lag integer;out_pending bigint;out_running bigint;out_failed bigint;out_expired bigint;out_lag integer;ai_queued bigint;ai_running bigint;ai_failed bigint;ai_expired bigint;ai_lag integer;reconcile bigint;alerts jsonb:='[]';
begin
 perform private.verified_actor();if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 select count(*),coalesce(greatest(0,extract(epoch from now()-min(d.due_at)))::integer,0) into due_n,due_lag from private.due_candidates d
 where d.tenant_id=p_tenant and not exists(select 1 from public.notifications n where n.tenant_id=d.tenant_id and n.recipient_id=d.recipient_id and n.dedupe_key=d.notice_key);
 select count(*) filter(where state='PENDING'),count(*) filter(where state='RUNNING'),count(*) filter(where state='FAILED'),count(*) filter(where state='RUNNING' and lease_until<=now()),coalesce(greatest(0,extract(epoch from now()-min(created_at) filter(where state in ('PENDING','RUNNING'))))::integer,0)
 into out_pending,out_running,out_failed,out_expired,out_lag from private.outbox_events where tenant_id=p_tenant;
 select count(*) filter(where state='QUEUED'),count(*) filter(where state='RUNNING'),count(*) filter(where state='FAILED'),count(*) filter(where state='RUNNING' and lease_until<=now()),coalesce(greatest(0,extract(epoch from now()-min(requested_at) filter(where state in ('QUEUED','RUNNING'))))::integer,0),count(*) filter(where usage_state='RECONCILE')
 into ai_queued,ai_running,ai_failed,ai_expired,ai_lag,reconcile from public.ai_jobs where tenant_id=p_tenant;
 if due_lag>900 then alerts:=alerts||jsonb_build_array('REMINDERS_DELAYED');end if;
 if out_lag>900 then alerts:=alerts||jsonb_build_array('NOTIFICATION_QUEUE_DELAYED');end if;
 if ai_lag>900 then alerts:=alerts||jsonb_build_array('AI_QUEUE_DELAYED');end if;
 if out_failed>0 then alerts:=alerts||jsonb_build_array('FAILED_NOTIFICATION_JOBS');end if;
 if ai_failed>0 then alerts:=alerts||jsonb_build_array('FAILED_AI_JOBS');end if;
 if reconcile>0 then alerts:=alerts||jsonb_build_array('AI_USAGE_RECONCILIATION');end if;
 if out_expired+ai_expired>0 then alerts:=alerts||jsonb_build_array('EXPIRED_WORKER_LEASES');end if;
 return jsonb_build_object('captured_at',statement_timestamp(),'lag_alert_seconds',900,
 'reminders',jsonb_build_object('awaiting_creation',due_n,'oldest_due_seconds',due_lag),
 'notifications',jsonb_build_object('pending',out_pending,'running',out_running,'failed',out_failed,'expired_leases',out_expired,'oldest_pending_seconds',out_lag),
 'ai',jsonb_build_object('queued',ai_queued,'running',ai_running,'failed',ai_failed,'expired_leases',ai_expired,'oldest_pending_seconds',ai_lag,'reconciliation',reconcile),
 'alerts',alerts,'cost_amount',null,'scheduler_verified',false);
end;$$;

-- Retain signature, access checks, output and grants from 202610070011_analysis.sql.
create or replace function public.analysis_usage(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);a public.agencies;
begin
 if m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;select * into a from public.agencies where id=p_tenant;
 return jsonb_build_object('daily_limit',a.ai_daily_limit,'monthly_limit',a.ai_monthly_limit,'daily_operations',coalesce((select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=(now() at time zone 'UTC')::date),0),
 'monthly_operations',coalesce((select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=date_trunc('month',now() at time zone 'UTC')::date),0),'reconciliation',(select count(*) from public.ai_jobs where tenant_id=p_tenant and usage_state='RECONCILE'));
end;$$;

-- Retain signature, access checks, output and grants from 202610070012_drafts.sql.
create or replace function public.draft_feedback_summary(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);
begin if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 return jsonb_build_object('total',(select count(*) from public.draft_feedback where tenant_id=p_tenant),'categories',coalesce((select jsonb_object_agg(category,n) from (select category,count(*) n from public.draft_feedback where tenant_id=p_tenant group by category) grouped),'{}'::jsonb));end;$$;

-- Retain signature, access checks, output and grants from 202610060008_capture.sql.
create or replace function public.duplicate_candidates(p_tenant uuid,p_lead uuid,p_limit integer default 25,p_after uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);l public.leads;rows jsonb;
begin
 select * into l from public.leads x where x.tenant_id=p_tenant and x.id=p_lead and (m.role<>'AGENT' or x.assignee_id=m.id);if not found then raise exception 'NOT_FOUND';end if;
 if m.role='AGENT' then return jsonb_build_object('review_required',l.duplicate_review,'candidates','[]'::jsonb,'restricted',true);end if;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into rows from (select x.id,x.full_name,x.email,x.phone,x.status,x.archived_at from public.leads x where x.tenant_id=p_tenant and x.id<>p_lead and (p_after is null or x.id>p_after) and ((l.email is not null and lower(trim(x.email))=lower(trim(l.email))) or (l.phone is not null and x.phone=l.phone)) order by x.id limit least(greatest(p_limit,1),101)) c;
 return jsonb_build_object('review_required',l.duplicate_review,'candidates',rows,'restricted',false);
end;$$;

-- Retain signature, access checks, output and grants from 202610070015_intake_key_rotation.sql.
create or replace function public.integration_encryption_key(p_tenant uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);k text;
begin if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;select key_id into k from private.intake_encryption_policy where singleton;return k;end;$$;

-- Retain signature, access checks, output and grants from 202610070017_intake_signing_roots.sql.
create or replace function public.integration_signing_root(p_tenant uuid,p_action text,p_id uuid,p_key uuid) returns text language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);i private.website_integrations;r private.intake_signing_issuances;op text;chosen text;
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

-- Retain signature, access checks, output and grants from 202610060007_notifications.sql.
create or replace function public.invitation_delivery_state(p_tenant uuid,p_invite uuid,p_key uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);invite public.invitations;job private.outbox_events;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 select * into invite from public.invitations where tenant_id=p_tenant and id=p_invite and (member.role='OWNER' or role='AGENT');if not found then raise exception 'NOT_FOUND';end if;
 select * into job from private.outbox_events where tenant_id=p_tenant and entity_id=p_invite and event_type='INVITATION_MAIL' and payload->>'request_key'=p_key::text and payload->>'actor_id'=auth.uid()::text and payload->>'token_hash'=invite.token_hash order by created_at desc,id desc limit 1;
 return jsonb_build_object('state',coalesce(job.state,'UNAVAILABLE'));
end; $$;

-- Retain signature, access checks, output and grants from 202610070016_invitation_key_rotation.sql.
create or replace function public.invitation_signing_key(p_tenant uuid,p_action text,p_invite uuid,p_key uuid,p_payload jsonb) returns text language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);i public.invitations;r private.invitation_issuances;op text;chosen text;
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

-- Retain signature, access checks, output and grants from 202610060009_imports.sql.
create or replace function public.lead_import_detail(p_tenant uuid,p_import uuid,p_after integer default 0,p_limit integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);i private.lead_imports;rows jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select * into i from private.lead_imports where tenant_id=p_tenant and id=p_import;if not found then raise exception 'NOT_FOUND';end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (select r.row_index,r.state,r.errors,r.attempts,r.lead_id,
 case when i.state='PREVIEW' then r.payload else null end as preview,
 case when i.state='PREVIEW' and r.payload is not null then exists(select 1 from public.leads l where l.tenant_id=p_tenant and ((coalesce(r.payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(r.payload->>'email'))) or (coalesce(r.payload->>'phone','')<>'' and l.phone=r.payload->>'phone'))) else false end as duplicate
 from private.lead_import_rows r where r.tenant_id=p_tenant and r.import_id=p_import and r.row_index>greatest(p_after,0) order by r.row_index limit least(greatest(p_limit,1),101)) x;
 return private.import_result(i.id)||jsonb_build_object('rows',rows);
end;$$;

-- Retain signature, access checks, output and grants from 202610060005_lead_controls.sql.
create or replace function public.list_assignment_members(p_tenant uuid) returns table(id uuid,role public.member_role,label text)
language plpgsql stable security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);
begin
 return query select m.id,m.role,coalesce(nullif(trim(m.display_name),''),m.role::text||' · '||left(m.id::text,8))
 from public.memberships m where m.tenant_id=p_tenant and m.active and (member.role in ('OWNER','ADMIN') or m.id=member.id) order by m.role,m.id;
end; $$;

-- Retain signature, access checks, output and grants from 202610060009_imports.sql.
create or replace function public.list_lead_imports(p_tenant uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 25) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);result jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select coalesce(jsonb_agg(private.import_result(x.id)),'[]') into result from (select id from private.lead_imports where tenant_id=p_tenant and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit least(greatest(p_limit,1),101)) x;return result;
end;$$;

-- Retain signature, access checks, output and grants from 202610060007_notifications.sql.
create or replace function public.list_notifications(p_tenant uuid,p_filter text default 'ALL',p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,type text,created_at timestamptz,read_at timestamptz,dismissed_at timestamptz,version integer,current boolean,can_open boolean,resource_label text,due_at timestamptz) language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);
begin
 if p_filter is null or p_filter not in ('ALL','UNREAD','DISMISSED') or p_limit is null or p_limit not between 1 and 101 then raise exception 'VALIDATION_FAILED';end if;
 return query select n.id,n.type,n.created_at,n.read_at,n.dismissed_at,n.version,private.notice_current(n),
 private.recipient_access(n.tenant_id,n.recipient_id,n.lead_id,n.task_id) and (n.lead_id is not null or private.notice_current(n)),
 case when private.notice_current(n) then l.full_name else null end,case when private.notice_current(n) then f.due_at else null end
 from public.notifications n left join public.leads l on l.tenant_id=n.tenant_id and l.id=n.lead_id left join public.follow_ups f on f.tenant_id=n.tenant_id and f.id=n.task_id
 where n.tenant_id=p_tenant and n.recipient_id=member.id and (p_filter='ALL' and n.dismissed_at is null or p_filter='UNREAD' and n.dismissed_at is null and n.read_at is null or p_filter='DISMISSED' and n.dismissed_at is not null)
 and (p_cursor_time is null or (n.created_at,n.id)<(p_cursor_time,p_cursor_id)) order by n.created_at desc,n.id desc limit p_limit;
end; $$;

-- Retain signature, access checks, output and grants from 202610070014_hardening.sql.
create or replace function public.list_privacy_cases(p_tenant uuid,p_cursor_time timestamptz default null,p_cursor_id uuid default null)
returns setof public.privacy_cases language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);
begin
 if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if (p_cursor_time is null)<>(p_cursor_id is null) then raise exception 'VALIDATION_FAILED';end if;
 return query select c.* from public.privacy_cases c where c.tenant_id=p_tenant and (p_cursor_time is null or (c.created_at,c.id)<(p_cursor_time,p_cursor_id)) order by c.created_at desc,c.id desc limit 26;
end;$$;

-- Retain signature, access checks, output and grants from 202610060007_notifications.sql.
create or replace function public.list_team_invitations(p_tenant uuid,p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,email text,role public.member_role,state text,expires_at timestamptz,version integer,created_at timestamptz,delivery_state text)
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 return query select i.id,i.email,i.role,case when i.state='PENDING' and i.expires_at<=now() then 'EXPIRED' else i.state end,i.expires_at,i.version,i.created_at,coalesce((select case when j.state='SUCCEEDED' then 'EMAIL_ACCEPTED' when j.state='FAILED' then 'EMAIL_FAILED' when j.state='CANCELLED' and j.last_error_code='LINK_ONLY' then 'LINK_ONLY' when j.state='CANCELLED' then 'EMAIL_UNAVAILABLE' else 'EMAIL_QUEUED' end from private.outbox_events j where j.tenant_id=i.tenant_id and j.entity_id=i.id and j.event_type='INVITATION_MAIL' and j.payload->>'token_hash'=i.token_hash order by j.created_at desc,j.id desc limit 1),'LINK_ONLY')
 from public.invitations i where i.tenant_id=p_tenant and (member.role='OWNER' or i.role='AGENT')
 and (p_cursor_time is null or (i.created_at,i.id)>(p_cursor_time,p_cursor_id)) order by i.created_at,i.id limit least(greatest(p_limit,1),101);
end; $$;

-- Retain signature, access checks, output and grants from 202610060006_team.sql.
create or replace function public.list_team_members(p_tenant uuid,p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,role public.member_role,active boolean,display_name text,email text,version integer,created_at timestamptz,lead_count bigint,open_task_count bigint)
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);
begin
 return query select m.id,m.role,m.active,m.display_name,u.email,m.version,m.created_at,
 (select count(*) from public.leads l where l.tenant_id=p_tenant and l.assignee_id=m.id),
 (select count(*) from public.follow_ups f where f.tenant_id=p_tenant and f.assignee_id=m.id and f.state='OPEN')
 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and (member.role in ('OWNER','ADMIN') or m.id=member.id)
 and (p_cursor_time is null or (m.created_at,m.id)>(p_cursor_time,p_cursor_id)) order by m.created_at,m.id limit least(greatest(p_limit,1),101);
end; $$;

-- Retain signature, access checks, output and grants from 202610060010_website_intake.sql.
create or replace function public.list_website_integrations(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);rows jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select coalesce(jsonb_agg(private.integration_view(i) order by i.created_at desc,i.id),'[]') into rows from private.website_integrations i where tenant_id=p_tenant;return rows;
end;$$;

-- Retain signature, access checks, output and grants from 202610060007_notifications.sql.
create or replace function public.notification_summary(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);count_value integer;
begin select count(*)::integer into count_value from public.notifications where tenant_id=p_tenant and recipient_id=member.id and read_at is null and dismissed_at is null;return jsonb_build_object('unread_count',count_value);end; $$;

-- Retain signature, access checks, output and grants from 202610060007_notifications.sql.
create or replace function public.open_notification(p_tenant uuid,p_notification uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);notice public.notifications;
begin
 select * into notice from public.notifications where tenant_id=p_tenant and id=p_notification and recipient_id=member.id;if not found then raise exception 'NOT_FOUND';end if;
 if not private.recipient_access(notice.tenant_id,notice.recipient_id,notice.lead_id,notice.task_id) then return jsonb_build_object('available',false);end if;
 if notice.lead_id is not null then return jsonb_build_object('available',true,'kind','lead','lead_id',notice.lead_id,'task_id',notice.task_id);end if;
 if notice.type='INVITE_ACCEPTED' and private.notice_current(notice) then return jsonb_build_object('available',true,'kind','team');end if;
 return jsonb_build_object('available',false);
end; $$;

-- Retain signature, access checks, output and grants from 202610070011_analysis.sql.
create or replace function public.team_snapshot(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);agency public.agencies;email text;result jsonb;
begin
 select * into agency from public.agencies where id=p_tenant;select u.email into email from auth.users u where u.id=auth.uid();
 result:=jsonb_build_object('membership',jsonb_build_object('id',member.id,'role',member.role,'version',member.version,'display_name',member.display_name,'email',email),
 'agency',jsonb_build_object('id',agency.id,'name',agency.name,'timezone',agency.timezone,'locale',agency.locale,'version',agency.version,'ai_enabled',agency.ai_enabled,'processing_approved',agency.processing_approved,'processing_reference',case when member.role in ('OWNER','ADMIN') then agency.processing_reference else null end),
 'pilot',case when member.role='OWNER' then jsonb_build_object('seat_limit',agency.seat_limit,'ai_monthly_limit',agency.ai_monthly_limit,'ai_daily_limit',agency.ai_daily_limit,'active_seats',(select count(*) from public.memberships m where m.tenant_id=p_tenant and m.active),'pending_seats',(select count(*) from public.invitations i where i.tenant_id=p_tenant and i.state='PENDING' and i.expires_at>now())) else null end,
 'onboarding',case when member.role in ('OWNER','ADMIN') then jsonb_build_object('Agency details',char_length(agency.name)>=2,'Processing settings',agency.processing_approved,'Invite team',(select exists(select 1 from public.invitations i where i.tenant_id=p_tenant)),'Sample lead',(select exists(select 1 from public.leads l where l.tenant_id=p_tenant)),'Schedule reminder',(select exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant))) else null end);
 return result;
end; $$;

notify pgrst,'reload schema';

-- Source: 202610100022_privacy_impact.sql
-- Current manager relationship inventory; no purge plan or mutation authority.
create function public.read_privacy_impact(p_tenant uuid,p_case uuid,p_expected_version integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);c public.privacy_cases;
 subject_version integer;holds bigint;active_jobs bigint;reconcile_jobs bigint;open_tasks bigint;
begin
 if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if p_case is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into c from public.privacy_cases where tenant_id=p_tenant and id=p_case;
 if not found then raise exception 'NOT_FOUND';end if;
 if c.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 if c.kind='LEAD_ERASURE' then
  select l.version into subject_version from public.leads l where l.tenant_id=p_tenant and l.id=c.lead_id;
 else
  select a.version into subject_version from public.agencies a where a.id=p_tenant;
 end if;
 if subject_version is null then raise exception 'NOT_FOUND';end if;
 select count(*) into holds from public.privacy_cases r where r.tenant_id=p_tenant and r.state='ON_HOLD'
  and (c.kind='AGENCY_CLOSURE' or r.kind='AGENCY_CLOSURE' or r.lead_id=c.lead_id);
 select count(*) filter(where j.state in ('QUEUED','RUNNING')),count(*) filter(where j.usage_state='RECONCILE')
  into active_jobs,reconcile_jobs from public.ai_jobs j where j.tenant_id=p_tenant and (c.lead_id is null or j.lead_id=c.lead_id);
 select count(*) into open_tasks from public.follow_ups f where f.tenant_id=p_tenant and f.state='OPEN' and (c.lead_id is null or f.lead_id=c.lead_id);
 return jsonb_build_object('tenant_id',p_tenant,'case_id',c.id,'case_version',c.version,'case_state',c.state,
  'kind',c.kind,'lead_id',c.lead_id,'subject_version',subject_version,'as_of',statement_timestamp(),
  'identity_verification_recorded',c.verification_reference is not null,'intersecting_holds',holds,
  'open_tasks',open_tasks,'active_ai_jobs',active_jobs,'reconcile_ai_jobs',reconcile_jobs,
  'retention_policy_approved',false,'inventory_complete',false,'execution_available',false,
  'counts',jsonb_build_object(
   'leads',(select count(*) from public.leads r where r.tenant_id=p_tenant and (c.lead_id is null or r.id=c.lead_id)),
   'messages',(select count(*) from public.messages r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'message_revisions',(select count(*) from public.message_revisions r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'follow_ups',(select count(*) from public.follow_ups r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'activity_events',(select count(*) from public.activity_events r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'ai_jobs',(select count(*) from public.ai_jobs r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'ai_analyses',(select count(*) from public.ai_analyses r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'reply_drafts',(select count(*) from public.reply_drafts r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'draft_feedback',(select count(*) from public.draft_feedback r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'notifications',(select count(*) from public.notifications r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'privacy_cases',(select count(*) from public.privacy_cases r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'privacy_case_actions',(select count(*) from public.privacy_case_actions r join public.privacy_cases parent on parent.tenant_id=r.tenant_id and parent.id=r.case_id where r.tenant_id=p_tenant and (c.lead_id is null or parent.lead_id=c.lead_id))));
end;$$;
revoke all on function public.read_privacy_impact(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_privacy_impact(uuid,uuid,integer) to authenticated;

-- Source: 202610100023_team_email_type.sql
-- Supabase auth.users.email is varchar(255); this RPC promises text.
-- RETURN QUERY requires matching types even though ordinary assignments coerce.
-- Preserve the read membership boundary, signature and existing function grants.
create or replace function public.list_team_members(p_tenant uuid,p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,role public.member_role,active boolean,display_name text,email text,version integer,created_at timestamptz,lead_count bigint,open_task_count bigint)
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);
begin
 return query select m.id,m.role,m.active,m.display_name,u.email::text,m.version,m.created_at,
 (select count(*) from public.leads l where l.tenant_id=p_tenant and l.assignee_id=m.id),
 (select count(*) from public.follow_ups f where f.tenant_id=p_tenant and f.assignee_id=m.id and f.state='OPEN')
 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and (member.role in ('OWNER','ADMIN') or m.id=member.id)
 and (p_cursor_time is null or (m.created_at,m.id)>(p_cursor_time,p_cursor_id)) order by m.created_at,m.id limit least(greatest(p_limit,1),101);
end; $$;

notify pgrst,'reload schema';

commit;
