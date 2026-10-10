begin;
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
commit;
