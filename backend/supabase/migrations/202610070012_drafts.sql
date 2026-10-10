begin;
alter table public.ai_jobs add column kind text not null default 'ANALYSIS' check(kind in ('ANALYSIS','DRAFT')),add column parameter_hash text,add column draft_policy_version integer;
grant select(kind) on public.ai_jobs to authenticated;
drop index public.one_active_analysis;
create unique index one_active_analysis on public.ai_jobs(tenant_id,lead_id,input_version,kind) where state in ('QUEUED','RUNNING');
create table private.draft_policy(singleton boolean primary key default true check(singleton),enabled boolean not null default false,version integer not null default 1);
insert into private.draft_policy(singleton) values(true);
create table public.reply_drafts(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,job_id uuid not null unique,input_version integer not null,
 state text not null check(state in ('GENERATED','EDITED','APPROVED','REJECTED','COPIED','SUPERSEDED','WITHHELD')),freshness text not null check(freshness in ('CURRENT','STALE')),version integer not null default 1,content_version integer not null default 1,
 original_text text not null check(char_length(original_text) between 1 and 5000),working_text text not null check(char_length(working_text) between 1 and 5000),language text not null check(language in ('en','ar')),tone text not null check(tone in ('PROFESSIONAL','FRIENDLY')),
 safety_flags jsonb not null default '[]',outline jsonb not null,model text not null,prompt_version text not null,schema_version text not null,observed_tokens bigint not null,latency_ms integer not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 approved_by uuid,approved_member_version integer,approved_assignment_version integer,approved_content_version integer,approved_input_version integer,approved_at timestamptz,rejection_reason text,
 unique(tenant_id,id),unique(tenant_id,lead_id,id),foreign key(tenant_id,lead_id,job_id) references public.ai_jobs(tenant_id,lead_id,id),foreign key(tenant_id,approved_by) references public.memberships(tenant_id,id));
create table public.draft_feedback(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,draft_id uuid not null,actor_id uuid not null references auth.users(id),content_version integer not null,
 category text not null check(category in ('USEFUL','INCORRECT','UNSAFE','UNHELPFUL')),comment text not null check(char_length(comment)<=500),created_at timestamptz not null default now(),foreign key(tenant_id,lead_id,draft_id) references public.reply_drafts(tenant_id,lead_id,id));
create table private.draft_copy_receipts(token uuid primary key default gen_random_uuid(),tenant_id uuid not null,draft_id uuid not null,actor_id uuid not null references auth.users(id),content_version integer not null,draft_version integer not null,expires_at timestamptz not null default now()+interval '2 minutes',completed_at timestamptz,foreign key(tenant_id,draft_id) references public.reply_drafts(tenant_id,id));
alter table public.reply_drafts enable row level security;alter table public.draft_feedback enable row level security;
create policy draft_read on public.reply_drafts for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=reply_drafts.tenant_id and l.id=reply_drafts.lead_id));
create policy draft_feedback_read on public.draft_feedback for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=draft_feedback.tenant_id and l.id=draft_feedback.lead_id));
revoke all on public.reply_drafts,public.draft_feedback from public,anon,authenticated;grant select on public.reply_drafts,public.draft_feedback to authenticated;
revoke all on private.draft_policy,private.draft_copy_receipts from public,anon,authenticated;
create function private.draft_safety(p_text text) returns jsonb language sql immutable set search_path='' as $$ select case when p_text ~* 'guarantee|guaranteed|guarantees|guaranteeing|مضمون|نضمن|مضمونة|visa|legal|financing|mortgage|تأشيرة|قانوني|تمويل|رهن|discount|خصم|available now|available today|is available|are available|available villas?|available units?|available apartments?|we have [0-9]+ (?:units?|villas?|apartments?)|confirmed viewing|booked|متاح الآن|متاحة الآن|مخفض|حجز مؤكد|ignore previous|ignore all|system prompt|api key|تجاهل التعليمات|<script|javascript:' then jsonb_build_array('UNSUPPORTED_OR_UNSAFE_CLAIM') else '[]'::jsonb end $$;
create or replace function private.analysis_allowed(j public.ai_jobs) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.leads l join public.agencies a on a.id=l.tenant_id join public.memberships m on m.tenant_id=l.tenant_id and m.id=j.requester_member_id join auth.users u on u.id=m.user_id cross join private.ai_policy p
 where l.tenant_id=j.tenant_id and l.id=j.lead_id and l.archived_at is null and l.status not in ('WON','LOST') and m.active and u.email_confirmed_at is not null and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
 and a.ai_enabled and a.processing_approved and p.enabled and p.rubric_approved and p.version=j.policy_version and p.model=j.model and j.prompt_version=case when j.kind='DRAFT' then 'draft-1' else p.prompt_version end and j.schema_version=case when j.kind='DRAFT' then 'draft-1' else p.schema_version end and (j.kind='ANALYSIS' or (not l.do_not_contact and exists(select 1 from private.draft_policy d where d.enabled and d.version=j.draft_policy_version))));
$$;
create function public.submit_draft(p_tenant uuid,p_lead uuid,p_expected_version integer,p_options jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;a public.agencies;p private.ai_policy;j public.ai_jobs;r private.api_requests;op text:='draft:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(jsonb_build_array(p_expected_version,p_options)::text,'UTF8')),'hex');snapshot jsonb;used integer;month_at date:=(date_trunc('month',now() at time zone 'UTC'))::date;day_at date:=(now() at time zone 'UTC')::date;result jsonb;draft_policy private.draft_policy;options jsonb;
begin
 if p_key is null or p_request_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 perform private.team_payload(p_options,array['language','tone','instruction']);
 if p_options->>'language' is null or p_options->>'language' not in ('en','ar') or p_options->>'tone' is null or p_options->>'tone' not in ('PROFESSIONAL','FRIENDLY') or jsonb_typeof(p_options->'instruction') is distinct from 'string' or char_length(p_options->>'instruction')>500 then raise exception 'VALIDATION_FAILED';end if;
 options:=p_options;
 options:=jsonb_set(options,'{instruction}',to_jsonb(regexp_replace(p_options->>'instruction','[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\+[0-9][0-9 ().-]{6,20}','[contact removed]','g')));
 select * into draft_policy from private.draft_policy;
 if not draft_policy.enabled then raise exception 'DRAFT_DISABLED';end if;
 select * into a from public.agencies where id=p_tenant;select * into p from private.ai_policy;
 if not p.enabled or not p.rubric_approved then raise exception 'AI_DISABLED';end if;if not a.ai_enabled or not a.processing_approved then raise exception 'PROCESSING_REQUIRED';end if;
 if l.do_not_contact or l.archived_at is not null or l.status in ('WON','LOST') then raise exception 'CONTACT_BLOCKED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if l.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 select * into j from public.ai_jobs where tenant_id=p_tenant and lead_id=p_lead and input_version=l.context_version and state in ('QUEUED','RUNNING') and kind='DRAFT';
 if found then if j.parameter_hash is distinct from encode(sha256(convert_to(options::text,'UTF8')),'hex') then raise exception 'DRAFT_IN_PROGRESS';end if;result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',true);
 else
  if a.ai_monthly_limit is null or a.ai_daily_limit is null then raise exception 'AI_LIMIT_REQUIRED';end if;
  insert into private.ai_submission_limits values(m.user_id,date_trunc('hour',now()),1) on conflict(actor_id,hour_at) do update set count=ai_submission_limits.count+1 returning count into used;
  if used>10 then raise exception 'AI_RATE_LIMITED';end if;
  insert into private.ai_usage_windows values(p_tenant,'MONTH',month_at,0) on conflict do nothing;insert into private.ai_usage_windows values(p_tenant,'DAY',day_at,0) on conflict do nothing;
  if (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=month_at)>=a.ai_monthly_limit or (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=day_at)>=a.ai_daily_limit then raise exception 'AI_QUOTA_REACHED';end if;
  update private.ai_usage_windows set operations=operations+1 where tenant_id=p_tenant and (kind='MONTH' and period_at=month_at or kind='DAY' and period_at=day_at);
  if not (p_options->>'language'=any(p.languages)) then raise exception 'DRAFT_LANGUAGE_UNAPPROVED';end if;
  snapshot:=private.analysis_snapshot(l)||jsonb_build_object('draft_options',options);
  while char_length(snapshot::text)>12000 loop if jsonb_array_length(snapshot->'messages')=0 then raise exception 'VALIDATION_FAILED';end if;snapshot:=jsonb_set(snapshot,'{messages}',(snapshot->'messages')-(jsonb_array_length(snapshot->'messages')-1));snapshot:=jsonb_set(snapshot,'{truncated}','true');end loop;
  insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at,kind,parameter_hash,draft_policy_version) values(p_tenant,p_lead,m.id,m.user_id,l.context_version,p.model,'draft-1','draft-1',p.version,month_at,day_at,'DRAFT',encode(sha256(convert_to(options::text,'UTF8')),'hex'),draft_policy.version) returning * into j;
  insert into private.ai_context values(j.id,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,p_lead,m.user_id,'DRAFT_QUEUED',p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'truncated',snapshot->'truncated'));
  result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',false);
 end if;
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create or replace function public.submit_analysis(p_tenant uuid,p_lead uuid,p_expected_version integer,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;a public.agencies;p private.ai_policy;j public.ai_jobs;r private.api_requests;op text:='analysis:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(coalesce(p_expected_version::text,''),'UTF8')),'hex');snapshot jsonb;used integer;month_at date:=(date_trunc('month',now() at time zone 'UTC'))::date;day_at date:=(now() at time zone 'UTC')::date;result jsonb;
begin
 if p_key is null or p_request_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into a from public.agencies where id=p_tenant;select * into p from private.ai_policy;
 if not p.enabled or not p.rubric_approved then raise exception 'AI_DISABLED';end if;if not a.ai_enabled or not a.processing_approved then raise exception 'PROCESSING_REQUIRED';end if;
 if l.archived_at is not null or l.status in ('WON','LOST') then raise exception 'CONTACT_BLOCKED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if l.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 select * into j from public.ai_jobs where tenant_id=p_tenant and lead_id=p_lead and input_version=l.context_version and state in ('QUEUED','RUNNING') and kind='ANALYSIS';
 if found then result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',true);
 else
  if a.ai_monthly_limit is null or a.ai_daily_limit is null then raise exception 'AI_LIMIT_REQUIRED';end if;
  insert into private.ai_submission_limits values(m.user_id,date_trunc('hour',now()),1) on conflict(actor_id,hour_at) do update set count=ai_submission_limits.count+1 returning count into used;
  if used>10 then raise exception 'AI_RATE_LIMITED';end if;
  insert into private.ai_usage_windows values(p_tenant,'MONTH',month_at,0) on conflict do nothing;insert into private.ai_usage_windows values(p_tenant,'DAY',day_at,0) on conflict do nothing;
  if (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=month_at)>=a.ai_monthly_limit or (select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=day_at)>=a.ai_daily_limit then raise exception 'AI_QUOTA_REACHED';end if;
  update private.ai_usage_windows set operations=operations+1 where tenant_id=p_tenant and (kind='MONTH' and period_at=month_at or kind='DAY' and period_at=day_at);
  snapshot:=private.analysis_snapshot(l);
  insert into public.ai_jobs(tenant_id,lead_id,requester_member_id,created_by,input_version,model,prompt_version,schema_version,policy_version,month_at,day_at) values(p_tenant,p_lead,m.id,m.user_id,l.context_version,p.model,p.prompt_version,p.schema_version,p.version,month_at,day_at) returning * into j;
  insert into private.ai_context values(j.id,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
  insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,p_lead,m.user_id,'ANALYSIS_QUEUED',p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'truncated',snapshot->'truncated'));
  result:=jsonb_build_object('job_id',j.id,'state',j.state,'reused',false);
 end if;
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create or replace function public.worker_claim_analysis(p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;j public.ai_jobs;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 for candidate in select id,tenant_id from public.ai_jobs where kind='ANALYSIS' and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) order by requested_at,id limit 20 loop
  perform 1 from public.agencies where id=candidate.tenant_id for update;
  select * into j from public.ai_jobs where id=candidate.id and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) for update skip locked;if not found then continue;end if;
  if j.state='RUNNING' and j.dispatched_at is not null then update public.ai_jobs set uncertain_usage=true where id=j.id returning * into j;end if;
  if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);continue;end if;
  if j.attempts>=3 then perform private.end_analysis(j.id,'FAILED','LEASE_EXHAUSTED',p_request_id);continue;end if;
  update public.ai_jobs set state='RUNNING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',dispatched_at=null,version=version+1 where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'lease_token',j.lease_token,'attempt',j.attempts,'model',j.model);
 end loop;return null;
end;$$;
create function public.worker_claim_draft(p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;j public.ai_jobs;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 for candidate in select id,tenant_id from public.ai_jobs where kind='DRAFT' and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) order by requested_at,id limit 20 loop
  perform 1 from public.agencies where id=candidate.tenant_id for update;
  select * into j from public.ai_jobs where id=candidate.id and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) for update skip locked;if not found then continue;end if;
  if j.state='RUNNING' and j.dispatched_at is not null then update public.ai_jobs set uncertain_usage=true where id=j.id returning * into j;end if;
  if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);continue;end if;
  if j.attempts>=3 then perform private.end_analysis(j.id,'FAILED','LEASE_EXHAUSTED',p_request_id);continue;end if;
  update public.ai_jobs set state='RUNNING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',dispatched_at=null,version=version+1 where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'lease_token',j.lease_token,'attempt',j.attempts,'model',j.model);
 end loop;return null;
end;$$;
create or replace function public.worker_prepare_analysis(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;snapshot jsonb;languages text[];
begin
 perform private.require_worker();select * into j from public.ai_jobs where id=p_job;if not found then return null;end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'ANALYSIS' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return null;end if;
 if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);return null;end if;
 select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;select p.languages into languages from private.ai_policy p;
 update public.ai_jobs set dispatched_at=now() where id=j.id;
 return jsonb_build_object('snapshot',snapshot,'model',j.model,'languages',languages,'input_version',j.input_version);
end;$$;
create function public.worker_prepare_draft(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;snapshot jsonb;languages text[];
begin
 perform private.require_worker();select * into j from public.ai_jobs where id=p_job;if not found then return null;end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'DRAFT' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return null;end if;
 if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);return null;end if;
 select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;select p.languages into languages from private.ai_policy p;
 update public.ai_jobs set dispatched_at=now() where id=j.id;
 return jsonb_build_object('snapshot',snapshot,'model',j.model,'languages',languages,'input_version',j.input_version);
end;$$;
create or replace function public.worker_finish_analysis(p_job uuid,p_lease uuid,p_result jsonb,p_tokens integer,p_latency integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;l public.leads;result public.ai_analyses;snapshot jsonb;e jsonb;fresh text;
begin
 perform private.require_worker();if p_request_id is null or p_tokens is null or p_tokens not between 0 and 250000 or p_latency is null or p_latency not between 0 and 90000 or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>48000 or p_result->>'rubric_version' is distinct from 'proposed-1' or jsonb_typeof(p_result->'score') is distinct from 'number' or (p_result->>'score')::numeric not between 0 and 100 or p_result->'analysis'->>'schema_version' is distinct from 'analysis-1' or jsonb_typeof(p_result->'analysis'->'field_evidence') is distinct from 'array' then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'ANALYSIS' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update public.ai_jobs set observed_tokens=observed_tokens+p_tokens where id=j.id returning * into j;
 if not private.analysis_allowed(j) then return private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);end if;
 select * into l from public.leads where tenant_id=j.tenant_id and id=j.lead_id for update;select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;
 for e in select value from jsonb_array_elements(p_result->'analysis'->'field_evidence') loop
  if not exists(select 1 from jsonb_array_elements(snapshot->'messages') m where m->>'id'=e->>'message_id' and m->>'version'=e->>'message_version' and char_length(e->>'excerpt') between 1 and 240 and strpos(m->>'body',e->>'excerpt')>0) then raise exception 'INVALID_EVIDENCE';end if;
 end loop;
 fresh:=case when l.context_version=j.input_version then 'CURRENT' else 'STALE' end;
 insert into public.ai_analyses(tenant_id,lead_id,job_id,input_version,freshness,result,model,prompt_version,schema_version,rubric_version,observed_tokens,latency_ms) values(j.tenant_id,j.lead_id,j.id,j.input_version,fresh,p_result,j.model,j.prompt_version,j.schema_version,'proposed-1',j.observed_tokens,p_latency) returning * into result;
 if fresh='CURRENT' then update public.leads set current_analysis_id=result.id where tenant_id=j.tenant_id and id=j.lead_id;end if;
 perform private.end_analysis(j.id,'SUCCEEDED',null,p_request_id);
 if fresh='CURRENT' then insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_READY',j.id,j.lead_id,'analysis-ready:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;end if;
 return jsonb_build_object('state','SUCCEEDED','freshness',fresh,'analysis_id',result.id);
end;$$;
create or replace function private.end_analysis(p_job uuid,p_state text,p_code text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;settled text;
begin
 select * into j from public.ai_jobs where id=p_job for update;
 settled:=case when j.uncertain_usage then 'RECONCILE' when j.observed_tokens>0 then 'CONSUMED' else 'RELEASED' end;
 if j.usage_state='RESERVED' and settled='RELEASED' then update private.ai_usage_windows set operations=operations-1 where tenant_id=j.tenant_id and (kind='DAY' and period_at=j.day_at or kind='MONTH' and period_at=j.month_at);end if;
 update public.ai_jobs set state=p_state,failure_code=p_code,usage_state=case when usage_state='RESERVED' then settled else usage_state end,lease_token=null,lease_until=null,completed_at=now(),reserved_tokens=case when settled='RECONCILE' then greatest(0,reserved_tokens-observed_tokens) else 0 end,version=version+1 where id=j.id returning * into j;
 delete from private.ai_context where job_id=j.id;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(j.tenant_id,j.lead_id,null,case when j.kind='DRAFT' then 'DRAFT_' else 'ANALYSIS_' end||p_state,p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'failure_code',p_code,'usage_state',j.usage_state));
 if p_state='FAILED' and private.analysis_allowed(j) and exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then
  insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_FAILED',j.id,j.lead_id,'analysis-failed:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;
 end if;
 return jsonb_build_object('state',j.state,'usage_state',j.usage_state);
end;$$;
create function public.worker_set_draft_policy(p_enabled boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.draft_policy;
begin perform private.require_worker();if p_enabled is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select * into p from private.draft_policy for update;if p.enabled is distinct from p_enabled then update private.draft_policy set enabled=p_enabled,version=version+1 returning * into p;insert into private.ai_policy_events(version,enabled,request_id) values(p.version,p.enabled,p_request_id);end if;return jsonb_build_object('enabled',p.enabled,'version',p.version);end;$$;
create function public.worker_finish_draft(p_job uuid,p_lease uuid,p_result jsonb,p_tokens integer,p_latency integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;l public.leads;d public.reply_drafts;snapshot jsonb;e jsonb;fresh text;safety jsonb;review_state text;
begin
 perform private.require_worker();if p_request_id is null or p_tokens is null or p_tokens not between 0 and 250000 or p_latency is null or p_latency not between 0 and 90000 or jsonb_typeof(p_result) is distinct from 'object' or p_result->>'schema_version' is distinct from 'draft-1' or jsonb_typeof(p_result->'text') is distinct from 'string' or char_length(trim(p_result->>'text')) not between 1 and 5000 or p_result->>'language' is null or p_result->>'language' not in ('en','ar') or p_result->>'tone' is null or p_result->>'tone' not in ('PROFESSIONAL','FRIENDLY') or jsonb_typeof(p_result->'outline'->'evidence') is distinct from 'array' then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.kind<>'DRAFT' or j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update public.ai_jobs set observed_tokens=observed_tokens+p_tokens where id=j.id returning * into j;
 if not private.analysis_allowed(j) then return private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);end if;
 select * into l from public.leads where tenant_id=j.tenant_id and id=j.lead_id for update;select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;
 if p_result->>'language' is distinct from snapshot->'draft_options'->>'language' or p_result->>'tone' is distinct from snapshot->'draft_options'->>'tone' then raise exception 'INVALID_EVIDENCE';end if;
 for e in select value from jsonb_array_elements(p_result->'outline'->'evidence') loop if not exists(select 1 from jsonb_array_elements(snapshot->'messages') m where m->>'id'=e->>'message_id' and m->>'version'=e->>'message_version' and char_length(e->>'excerpt') between 1 and 240 and strpos(m->>'body',e->>'excerpt')>0) then raise exception 'INVALID_EVIDENCE';end if;end loop;
 fresh:=case when l.context_version=j.input_version then 'CURRENT' else 'STALE' end;safety:=private.draft_safety(p_result->>'text');review_state:=case when fresh='STALE' then 'SUPERSEDED' when safety<>'[]'::jsonb then 'WITHHELD' else 'GENERATED' end;
 if fresh='CURRENT' then update public.reply_drafts set state='SUPERSEDED',version=version+1,approved_by=null,approved_at=null where tenant_id=j.tenant_id and lead_id=j.lead_id and state in ('GENERATED','EDITED','APPROVED','COPIED');end if;
 insert into public.reply_drafts(tenant_id,lead_id,job_id,input_version,state,freshness,original_text,working_text,language,tone,safety_flags,outline,model,prompt_version,schema_version,observed_tokens,latency_ms) values(j.tenant_id,j.lead_id,j.id,j.input_version,review_state,fresh,p_result->>'text',p_result->>'text',p_result->>'language',p_result->>'tone',safety,p_result->'outline',j.model,j.prompt_version,j.schema_version,j.observed_tokens,p_latency) returning * into d;
 perform private.end_analysis(j.id,'SUCCEEDED',null,p_request_id);
 insert into public.activity_events(tenant_id,lead_id,event_type,request_id,details) values(j.tenant_id,j.lead_id,'DRAFT_'||review_state,p_request_id,jsonb_build_object('draft_id',d.id,'input_version',d.input_version));
 if fresh='CURRENT' then insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_READY',j.id,j.lead_id,'draft-ready:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;end if;
 return jsonb_build_object('state','SUCCEEDED','freshness',fresh,'draft_id',d.id,'review_state',review_state);
end;$$;
create function private.invalidate_draft_review() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.context_version<>old.context_version then update public.reply_drafts set state='SUPERSEDED',freshness='STALE',version=version+1,approved_by=null,approved_at=null where tenant_id=new.tenant_id and lead_id=new.id and state in ('GENERATED','EDITED','APPROVED','COPIED','WITHHELD');
 elsif new.assignment_version<>old.assignment_version or new.archived_at is distinct from old.archived_at or new.do_not_contact is distinct from old.do_not_contact or (new.status is distinct from old.status and (new.status in ('WON','LOST') or old.status in ('WON','LOST'))) then update public.reply_drafts set state='EDITED',version=version+1,approved_by=null,approved_at=null where tenant_id=new.tenant_id and lead_id=new.id and state in ('APPROVED','COPIED');end if;return new;
end;$$;
create trigger invalidate_draft_review after update on public.leads for each row execute function private.invalidate_draft_review();
create function private.draft_outreach(l public.leads) returns void language plpgsql security definer set search_path='' as $$
begin if l.archived_at is not null or l.status in ('WON','LOST') or l.do_not_contact then raise exception 'CONTACT_BLOCKED';end if;
 if not exists(select 1 from public.agencies a cross join private.ai_policy p cross join private.draft_policy dp where a.id=l.tenant_id and a.processing_approved and a.ai_enabled and p.enabled and dp.enabled) then raise exception 'DRAFT_DISABLED';end if;end;$$;
create or replace function private.notice_current(n public.notifications) returns boolean language plpgsql stable security definer set search_path='' as $$
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
 if n.type in ('AI_READY','AI_FAILED') then
  return lead.context_version=n.input_version and exists(select 1 from public.ai_jobs j where j.tenant_id=n.tenant_id and j.lead_id=n.lead_id and j.id=n.resource_id and j.requester_member_id=n.recipient_id and j.input_version=n.input_version and (j.kind='ANALYSIS' or not lead.do_not_contact) and (n.type='AI_READY' and j.state='SUCCEEDED' and exists(select 1 from public.ai_analyses a where a.job_id=j.id and a.id=lead.current_analysis_id) or n.type='AI_READY' and j.state='SUCCEEDED' and j.kind='DRAFT' and exists(select 1 from public.reply_drafts d where d.job_id=j.id and d.input_version=lead.context_version and d.freshness='CURRENT' and d.state in ('GENERATED','EDITED','APPROVED','COPIED','WITHHELD')) or n.type='AI_FAILED' and j.state='FAILED'));
 end if;
 return false;
end; $$;
create function public.mutate_draft(p_tenant uuid,p_draft uuid,p_action text,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;d public.reply_drafts;r private.api_requests;receipt private.draft_copy_receipts;result jsonb;flags jsonb;feedback_id uuid;message jsonb;op text:='draft-action:'||p_tenant||':'||p_draft||':'||p_action;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if p_action is null or p_action not in ('EDIT','APPROVE','REJECT','FEEDBACK','COPY_AUTH','COPY_DONE','LOG_EXTERNAL') or p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED';end if;
 perform private.team_payload(p_payload,case p_action when 'EDIT' then array['expected_version','text'] when 'APPROVE' then array['expected_version','acknowledged'] when 'REJECT' then array['expected_version','reason'] when 'FEEDBACK' then array['expected_version','category','comment'] when 'COPY_AUTH' then array['expected_version'] when 'COPY_DONE' then array['expected_version','copy_token'] when 'LOG_EXTERNAL' then array['expected_version','expected_lead_version','body','occurred_at','sent_confirmed'] end);
 select * into l from public.leads where tenant_id=p_tenant and id=(select x.lead_id from public.reply_drafts x where x.tenant_id=p_tenant and x.id=p_draft) and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into d from public.reply_drafts where tenant_id=p_tenant and id=p_draft for update;
 if p_action in ('APPROVE','COPY_AUTH','COPY_DONE') then perform private.draft_outreach(l);if d.input_version<>l.context_version or d.freshness<>'CURRENT' then raise exception 'DRAFT_STALE';end if;end if;
 if p_action in ('COPY_AUTH','COPY_DONE') then
  if d.state not in ('APPROVED','COPIED') or d.safety_flags<>'[]'::jsonb or d.approved_by is distinct from m.id or d.approved_member_version is distinct from m.version or d.approved_assignment_version is distinct from l.assignment_version or d.approved_content_version is distinct from d.content_version or d.approved_input_version is distinct from l.context_version then raise exception 'DRAFT_REVIEW_REQUIRED';end if;
 end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;
 if found then
  if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if p_action='COPY_AUTH' and not exists(select 1 from private.draft_copy_receipts c where c.token=(r.response->>'copy_token')::uuid and c.actor_id=m.user_id and c.content_version=d.content_version and c.expires_at>now()) then raise exception 'COPY_EXPIRED';end if;
  return r.response;
 end if;
 if p_payload->>'expected_version' is distinct from d.version::text then raise exception 'VERSION_CONFLICT';end if;
 if p_action='EDIT' then
  if d.input_version<>l.context_version or d.state='SUPERSEDED' then raise exception 'DRAFT_STALE';end if;if d.state='REJECTED' then raise exception 'STATE_CONFLICT';end if;
  if jsonb_typeof(p_payload->'text') is distinct from 'string' or char_length(trim(p_payload->>'text')) not between 1 and 5000 then raise exception 'VALIDATION_FAILED';end if;
  flags:=private.draft_safety(p_payload->>'text');update public.reply_drafts set working_text=trim(p_payload->>'text'),state=case when flags='[]'::jsonb then 'EDITED' else 'WITHHELD' end,safety_flags=flags,content_version=content_version+1,version=version+1,approved_by=null,approved_at=null,updated_at=now() where id=d.id returning * into d;result:=to_jsonb(d);
 elsif p_action='APPROVE' then
  if p_payload->'acknowledged' is distinct from 'true'::jsonb then raise exception 'DRAFT_REVIEW_REQUIRED';end if;
  if d.state not in ('GENERATED','EDITED','APPROVED','COPIED') or d.safety_flags<>'[]'::jsonb or private.draft_safety(d.working_text)<>'[]'::jsonb then raise exception 'DRAFT_UNSAFE';end if;
  update public.reply_drafts set state='APPROVED',approved_by=m.id,approved_member_version=m.version,approved_assignment_version=l.assignment_version,approved_content_version=content_version,approved_input_version=l.context_version,approved_at=now(),version=version+1,updated_at=now() where id=d.id returning * into d;result:=to_jsonb(d);
 elsif p_action='REJECT' then
  if jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;if d.state='REJECTED' then raise exception 'STATE_CONFLICT';end if;
  update public.reply_drafts set state='REJECTED',rejection_reason=trim(p_payload->>'reason'),approved_by=null,approved_at=null,version=version+1,updated_at=now() where id=d.id returning * into d;result:=to_jsonb(d);
 elsif p_action='FEEDBACK' then
  if p_payload->>'category' is null or p_payload->>'category' not in ('USEFUL','INCORRECT','UNSAFE','UNHELPFUL') or jsonb_typeof(p_payload->'comment') is distinct from 'string' or char_length(p_payload->>'comment')>500 then raise exception 'VALIDATION_FAILED';end if;
  insert into public.draft_feedback(tenant_id,lead_id,draft_id,actor_id,content_version,category,comment) values(p_tenant,l.id,d.id,m.user_id,d.content_version,p_payload->>'category',trim(p_payload->>'comment')) returning id into feedback_id;
  if p_payload->>'category'='UNSAFE' then update public.reply_drafts set state=case when state='SUPERSEDED' then state else 'WITHHELD' end,safety_flags=jsonb_build_array('HUMAN_UNSAFE_FEEDBACK'),approved_by=null,approved_at=null,version=version+1,updated_at=now() where id=d.id returning * into d;end if;
  result:=jsonb_build_object('feedback_id',feedback_id,'draft',to_jsonb(d));
 elsif p_action='COPY_AUTH' then
  insert into private.draft_copy_receipts(tenant_id,draft_id,actor_id,content_version,draft_version) values(p_tenant,d.id,m.user_id,d.content_version,d.version) returning * into receipt;
  result:=jsonb_build_object('text',d.working_text,'copy_token',receipt.token,'expected_version',d.version,'expires_at',receipt.expires_at);
 elsif p_action='COPY_DONE' then
  if p_payload->>'copy_token' is null or p_payload->>'copy_token' !~ '^[0-9a-fA-F-]{36}$' then raise exception 'VALIDATION_FAILED';end if;
  select * into receipt from private.draft_copy_receipts where token=(p_payload->>'copy_token')::uuid and tenant_id=p_tenant and draft_id=d.id and actor_id=m.user_id for update;
  if not found or receipt.expires_at<=now() then raise exception 'COPY_EXPIRED';end if;if receipt.completed_at is not null then raise exception 'STATE_CONFLICT';end if;
  if receipt.content_version<>d.content_version or receipt.draft_version<>d.version then raise exception 'VERSION_CONFLICT';end if;
  update private.draft_copy_receipts set completed_at=now() where token=receipt.token;
  update public.reply_drafts set state='COPIED',version=version+1,updated_at=now() where id=d.id returning * into d;result:=jsonb_build_object('draft',to_jsonb(d),'copied',true);
 elsif p_action='LOG_EXTERNAL' then
  if p_payload->'sent_confirmed' is distinct from 'true'::jsonb or not exists(select 1 from private.draft_copy_receipts c where c.tenant_id=p_tenant and c.draft_id=d.id and c.actor_id=m.user_id and c.completed_at is not null) then raise exception 'EXTERNAL_LOG_CONFIRMATION_REQUIRED';end if;
  message:=public.add_lead_message(p_tenant,l.id,jsonb_build_object('direction','OUTBOUND','body',p_payload->'body','occurred_at',p_payload->'occurred_at','expected_version',p_payload->'expected_lead_version'),p_key,p_request_id);
  result:=jsonb_build_object('message',message,'draft_id',d.id);
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,l.id,m.user_id,case when p_action='COPY_AUTH' then 'DRAFT_COPY_AUTHORIZED' when p_action='COPY_DONE' then 'DRAFT_COPIED' when p_action='LOG_EXTERNAL' then 'DRAFT_EXTERNAL_LOGGED' else 'DRAFT_'||p_action end,p_request_id,p_payload->>'reason',jsonb_build_object('draft_id',d.id,'draft_version',d.version,'content_version',d.content_version,'input_version',d.input_version,'feedback_category',p_payload->>'category'));
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create function public.worker_draft_metrics() returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.require_worker();return jsonb_build_object('queued',(select count(*) from public.ai_jobs where kind='DRAFT' and state='QUEUED'),'failed',(select count(*) from public.ai_jobs where kind='DRAFT' and state='FAILED'),'withheld',(select count(*) from public.reply_drafts where state='WITHHELD'));end;$$;
create function public.draft_feedback_summary(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);
begin if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 return jsonb_build_object('total',(select count(*) from public.draft_feedback where tenant_id=p_tenant),'categories',coalesce((select jsonb_object_agg(category,n) from (select category,count(*) n from public.draft_feedback where tenant_id=p_tenant group by category) grouped),'{}'::jsonb));end;$$;
revoke all on function private.draft_safety(text),private.invalidate_draft_review(),private.draft_outreach(public.leads) from public,anon,authenticated;
revoke all on function public.submit_draft(uuid,uuid,integer,jsonb,uuid,uuid),public.mutate_draft(uuid,uuid,text,jsonb,uuid,uuid),public.draft_feedback_summary(uuid) from public,anon;
grant execute on function public.submit_draft(uuid,uuid,integer,jsonb,uuid,uuid),public.mutate_draft(uuid,uuid,text,jsonb,uuid,uuid),public.draft_feedback_summary(uuid) to authenticated;
revoke all on function public.worker_set_draft_policy(boolean,uuid),public.worker_claim_draft(uuid),public.worker_prepare_draft(uuid,uuid,uuid),public.worker_finish_draft(uuid,uuid,jsonb,integer,integer,uuid),public.worker_draft_metrics() from public,anon,authenticated;
grant execute on function public.worker_set_draft_policy(boolean,uuid),public.worker_claim_draft(uuid),public.worker_prepare_draft(uuid,uuid,uuid),public.worker_finish_draft(uuid,uuid,jsonb,integer,integer,uuid),public.worker_draft_metrics() to service_role;
commit;
