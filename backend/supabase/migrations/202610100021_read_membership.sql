begin;
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
commit;
