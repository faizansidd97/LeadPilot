begin;
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

commit;
