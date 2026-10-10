-- Foundation only. Reviewed transactional RPCs must precede write access.
begin;
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
commit;
