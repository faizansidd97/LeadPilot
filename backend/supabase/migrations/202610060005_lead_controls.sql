begin;
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
commit;
