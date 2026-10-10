begin;
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
commit;
