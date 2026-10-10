begin;
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
commit;
