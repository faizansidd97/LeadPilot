begin;
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
commit;