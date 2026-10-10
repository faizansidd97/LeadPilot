begin;
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
commit;
