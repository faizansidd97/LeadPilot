-- Authenticated transactional services. No service-role client is used by user APIs.
begin;
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
commit;

