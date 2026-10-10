begin;
alter table public.agencies add column ai_daily_limit integer check(ai_daily_limit between 0 and 1000000);
alter table public.leads add column facts_confirmed_at timestamptz,add column current_analysis_id uuid;
create table private.ai_policy(singleton boolean primary key default true check(singleton),enabled boolean not null default false,model text not null default '',prompt_version text not null default 'analysis-1',schema_version text not null default 'analysis-1',rubric_approved boolean not null default false,languages text[] not null default '{}',version integer not null default 1);
insert into private.ai_policy(singleton) values(true);
create table private.ai_policy_events(id uuid primary key default gen_random_uuid(),version integer not null,enabled boolean not null,request_id uuid not null,created_at timestamptz not null default now());
create table public.ai_jobs(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),lead_id uuid not null,requester_member_id uuid not null,created_by uuid not null references auth.users(id),
 state text not null default 'QUEUED' check(state in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),version integer not null default 1,input_version integer not null,model text not null,prompt_version text not null,schema_version text not null,policy_version integer not null,
 attempts integer not null default 0 check(attempts between 0 and 3),available_at timestamptz not null default now(),lease_token uuid,lease_until timestamptz,dispatched_at timestamptz,
 uncertain_usage boolean not null default false,observed_tokens bigint not null default 0,reserved_tokens bigint not null default 192000,usage_state text not null default 'RESERVED' check(usage_state in ('RESERVED','CONSUMED','RELEASED','RECONCILE')),
 requested_at timestamptz not null default now(),completed_at timestamptz,failure_code text,month_at date not null,day_at date not null,unique(tenant_id,lead_id,id),unique(tenant_id,id),
 foreign key(tenant_id,lead_id) references public.leads(tenant_id,id),foreign key(tenant_id,requester_member_id) references public.memberships(tenant_id,id),
 check((state='RUNNING' and lease_token is not null and lease_until is not null) or (state<>'RUNNING' and lease_token is null and lease_until is null)));
create unique index one_active_analysis on public.ai_jobs(tenant_id,lead_id,input_version) where state in ('QUEUED','RUNNING');
create index analysis_claim on public.ai_jobs(state,available_at,lease_until,requested_at,id);
create index analysis_history on public.ai_jobs(tenant_id,lead_id,requested_at desc,id desc);
create table private.ai_context(job_id uuid primary key references public.ai_jobs(id),snapshot jsonb not null check(char_length(snapshot::text)<=12000),snapshot_hash text not null);
create table private.ai_usage_windows(tenant_id uuid not null references public.agencies(id),kind text not null check(kind in ('DAY','MONTH')),period_at date not null,operations integer not null check(operations>=0),primary key(tenant_id,kind,period_at));
create table private.ai_submission_limits(actor_id uuid not null references auth.users(id),hour_at timestamptz not null,count integer not null,primary key(actor_id,hour_at));
create table public.ai_analyses(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,job_id uuid not null unique,input_version integer not null,freshness text not null check(freshness in ('CURRENT','STALE')),
 result jsonb not null,model text not null,prompt_version text not null,schema_version text not null,rubric_version text not null,observed_tokens bigint not null,latency_ms integer not null,created_at timestamptz not null default now(),
 unique(tenant_id,lead_id,id),foreign key(tenant_id,lead_id,job_id) references public.ai_jobs(tenant_id,lead_id,id));
alter table public.leads add constraint current_analysis_parent foreign key(tenant_id,id,current_analysis_id) references public.ai_analyses(tenant_id,lead_id,id);
alter table public.ai_jobs enable row level security;alter table public.ai_analyses enable row level security;
create policy analysis_job_read on public.ai_jobs for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=ai_jobs.tenant_id and l.id=ai_jobs.lead_id));
create policy analysis_result_read on public.ai_analyses for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=ai_analyses.tenant_id and l.id=ai_analyses.lead_id));
revoke all on public.ai_jobs,public.ai_analyses from public,anon,authenticated;
grant select(id,tenant_id,lead_id,state,version,input_version,attempts,model,prompt_version,schema_version,requested_at,completed_at,failure_code,usage_state,observed_tokens) on public.ai_jobs to authenticated;
grant select on public.ai_analyses to authenticated;
revoke all on private.ai_policy,private.ai_policy_events,private.ai_context,private.ai_usage_windows,private.ai_submission_limits from public,anon,authenticated;
create function private.analysis_context_changed() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='INSERT' then if new.source in ('MANUAL','CSV') then new.facts_confirmed_at:=now();end if;
 elsif new.context_version<>old.context_version then
  new.current_analysis_id:=null;
  if (new.confirmed_intent,new.budget_min,new.budget_max,new.currency,new.locations,new.bedrooms,new.property_type,new.purchase_timeline) is distinct from (old.confirmed_intent,old.budget_min,old.budget_max,old.currency,old.locations,old.bedrooms,old.property_type,old.purchase_timeline) then new.facts_confirmed_at:=now();end if;
 end if;return new;
end;$$;
create trigger analysis_context_changed before insert or update on public.leads for each row execute function private.analysis_context_changed();
create function private.analysis_snapshot(l public.leads) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;messages jsonb:='[]';m record;entry jsonb;body text;remaining integer;truncated boolean:=false;seen integer:=0;
begin
 result:=jsonb_build_object('confirmed',jsonb_build_object('confirmed_intent',l.confirmed_intent,'budget_min',l.budget_min,'budget_max',l.budget_max,'currency',l.currency,'budget_period',l.budget_period,'locations',l.locations,'property_type',l.property_type,'bedrooms',l.bedrooms,'purchase_timeline',l.purchase_timeline),
 'facts_confirmed_at',l.facts_confirmed_at,'requested_at',now(),'truncated',false,'messages',messages);
 for m in select msg.id,msg.version,msg.body,msg.occurred_at from public.messages msg where msg.tenant_id=l.tenant_id and msg.lead_id=l.id and msg.direction='INBOUND' order by msg.occurred_at desc,msg.created_at desc,msg.id desc limit 51 loop
  seen:=seen+1;if seen>50 then truncated:=true;exit;end if;
  body:=regexp_replace(m.body,'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}','[email removed]','g');
  if nullif(l.phone,'') is not null then body:=replace(body,l.phone,'[phone removed]');end if;
  body:=regexp_replace(body,'\+[0-9][0-9 ().-]{6,20}','[phone removed]','g');
  remaining:=12000-char_length(result::text)-2;if remaining<260 then truncated:=true;exit;end if;
  entry:=jsonb_build_object('id',m.id,'version',m.version,'body',body,'occurred_at',m.occurred_at);
  while char_length(entry::text)>remaining loop truncated:=true;body:=left(body,greatest(0,char_length(body)-greatest(1,(char_length(entry::text)-remaining)/2)));entry:=jsonb_set(entry,'{body}',to_jsonb(body));end loop;
  messages:=messages||jsonb_build_array(entry);result:=jsonb_set(result,'{messages}',messages);
  if truncated then exit;end if;
 end loop;
 return jsonb_set(result,'{truncated}',to_jsonb(truncated));
end;$$;
create function private.analysis_allowed(j public.ai_jobs) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.leads l join public.agencies a on a.id=l.tenant_id join public.memberships m on m.tenant_id=l.tenant_id and m.id=j.requester_member_id join auth.users u on u.id=m.user_id cross join private.ai_policy p
 where l.tenant_id=j.tenant_id and l.id=j.lead_id and l.archived_at is null and l.status not in ('WON','LOST') and m.active and u.email_confirmed_at is not null and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
 and a.ai_enabled and a.processing_approved and p.enabled and p.rubric_approved and p.version=j.policy_version and p.model=j.model and p.prompt_version=j.prompt_version and p.schema_version=j.schema_version);
$$;
create function public.submit_analysis(p_tenant uuid,p_lead uuid,p_expected_version integer,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;a public.agencies;p private.ai_policy;j public.ai_jobs;r private.api_requests;op text:='analysis:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(coalesce(p_expected_version::text,''),'UTF8')),'hex');snapshot jsonb;used integer;month_at date:=(date_trunc('month',now() at time zone 'UTC'))::date;day_at date:=(now() at time zone 'UTC')::date;result jsonb;
begin
 if p_key is null or p_request_id is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into a from public.agencies where id=p_tenant;select * into p from private.ai_policy;
 if not p.enabled or not p.rubric_approved then raise exception 'AI_DISABLED';end if;if not a.ai_enabled or not a.processing_approved then raise exception 'PROCESSING_REQUIRED';end if;
 if l.archived_at is not null or l.status in ('WON','LOST') then raise exception 'CONTACT_BLOCKED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if l.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 select * into j from public.ai_jobs where tenant_id=p_tenant and lead_id=p_lead and input_version=l.context_version and state in ('QUEUED','RUNNING');
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
create function private.end_analysis(p_job uuid,p_state text,p_code text,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;settled text;
begin
 select * into j from public.ai_jobs where id=p_job for update;
 settled:=case when j.uncertain_usage then 'RECONCILE' when j.observed_tokens>0 then 'CONSUMED' else 'RELEASED' end;
 if j.usage_state='RESERVED' and settled='RELEASED' then update private.ai_usage_windows set operations=operations-1 where tenant_id=j.tenant_id and (kind='DAY' and period_at=j.day_at or kind='MONTH' and period_at=j.month_at);end if;
 update public.ai_jobs set state=p_state,failure_code=p_code,usage_state=case when usage_state='RESERVED' then settled else usage_state end,lease_token=null,lease_until=null,completed_at=now(),reserved_tokens=case when settled='RECONCILE' then greatest(0,reserved_tokens-observed_tokens) else 0 end,version=version+1 where id=j.id returning * into j;
 delete from private.ai_context where job_id=j.id;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(j.tenant_id,j.lead_id,null,'ANALYSIS_'||p_state,p_request_id,jsonb_build_object('job_id',j.id,'input_version',j.input_version,'failure_code',p_code,'usage_state',j.usage_state));
 if p_state='FAILED' and private.analysis_allowed(j) and exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then
  insert into public.notifications(tenant_id,recipient_id,type,resource_id,lead_id,dedupe_key,input_version) values(j.tenant_id,j.requester_member_id,'AI_FAILED',j.id,j.lead_id,'analysis-failed:'||j.id,j.input_version) on conflict(tenant_id,recipient_id,dedupe_key) do nothing;
 end if;
 return jsonb_build_object('state',j.state,'usage_state',j.usage_state);
end;$$;
alter table public.notifications add column input_version integer;
create function public.cancel_analysis(p_tenant uuid,p_job uuid,p_expected_version integer,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);j public.ai_jobs;r private.api_requests;op text:='cancel-analysis:'||p_tenant||':'||p_job;h text:=encode(sha256(convert_to(coalesce(p_expected_version::text,''),'UTF8')),'hex');result jsonb;
begin
 if p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select x.* into j from public.ai_jobs x join public.leads l on l.tenant_id=x.tenant_id and l.id=x.lead_id where x.tenant_id=p_tenant and x.id=p_job and (m.role<>'AGENT' or l.assignee_id=m.id) for update of x;if not found then raise exception 'NOT_FOUND';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if j.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;if j.state not in ('QUEUED','RUNNING') then raise exception 'STATE_CONFLICT';end if;
 update public.ai_jobs set uncertain_usage=uncertain_usage or dispatched_at is not null where id=j.id;result:=private.end_analysis(j.id,'CANCELLED','USER_CANCELLED',p_request_id);
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
create function public.worker_set_ai_policy(p_enabled boolean,p_model text,p_languages text[],p_rubric_approved boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p private.ai_policy;
begin
 perform private.require_worker();if p_enabled is null or p_rubric_approved is null or p_request_id is null or p_model is null or char_length(p_model)>120 or p_languages is null or cardinality(p_languages)>3 or exists(select 1 from unnest(p_languages) l where l not in ('en','ar','mixed')) or (p_enabled and (not p_rubric_approved or cardinality(p_languages)=0 or p_model !~ '^[a-zA-Z0-9._:-]{1,120}$')) then raise exception 'VALIDATION_FAILED';end if;
 select * into p from private.ai_policy for update;
 if (p.enabled,p.model,p.languages,p.rubric_approved) is distinct from (p_enabled,p_model,p_languages,p_rubric_approved) then
  update private.ai_policy set enabled=p_enabled,model=p_model,languages=p_languages,rubric_approved=p_rubric_approved,version=version+1 returning * into p;
  insert into private.ai_policy_events(version,enabled,request_id) values(p.version,p.enabled,p_request_id);
 end if;return jsonb_build_object('enabled',p.enabled,'version',p.version);
end;$$;
create function public.worker_claim_analysis(p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate record;j public.ai_jobs;
begin
 perform private.require_worker();if p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 for candidate in select id,tenant_id from public.ai_jobs where state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now() order by requested_at,id limit 20 loop
  perform 1 from public.agencies where id=candidate.tenant_id for update;
  select * into j from public.ai_jobs where id=candidate.id and (state='QUEUED' and available_at<=now() or state='RUNNING' and lease_until<=now()) for update skip locked;if not found then continue;end if;
  if j.state='RUNNING' and j.dispatched_at is not null then update public.ai_jobs set uncertain_usage=true where id=j.id returning * into j;end if;
  if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);continue;end if;
  if j.attempts>=3 then perform private.end_analysis(j.id,'FAILED','LEASE_EXHAUSTED',p_request_id);continue;end if;
  update public.ai_jobs set state='RUNNING',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',dispatched_at=null,version=version+1 where id=j.id returning * into j;
  return jsonb_build_object('id',j.id,'lease_token',j.lease_token,'attempt',j.attempts,'model',j.model);
 end loop;return null;
end;$$;
create function public.worker_prepare_analysis(p_job uuid,p_lease uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;snapshot jsonb;languages text[];
begin
 perform private.require_worker();select * into j from public.ai_jobs where id=p_job;if not found then return null;end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return null;end if;
 if not private.analysis_allowed(j) or not exists(select 1 from public.leads where tenant_id=j.tenant_id and id=j.lead_id and context_version=j.input_version) then perform private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);return null;end if;
 select c.snapshot into snapshot from private.ai_context c where c.job_id=j.id;select p.languages into languages from private.ai_policy p;
 update public.ai_jobs set dispatched_at=now() where id=j.id;
 return jsonb_build_object('snapshot',snapshot,'model',j.model,'languages',languages,'input_version',j.input_version);
end;$$;
create function public.worker_fail_analysis(p_job uuid,p_lease uuid,p_code text,p_transient boolean,p_tokens integer,p_uncertain boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;
begin
 perform private.require_worker();if p_code is null or p_code not in ('PROVIDER_TIMEOUT','PROVIDER_RATE_LIMIT','PROVIDER_UNAVAILABLE','PROVIDER_CONFIG','REFUSED','INCOMPLETE','INVALID_SCHEMA','INVALID_EVIDENCE','UNSUPPORTED_SUMMARY','UNSAFE_OUTPUT','UNKNOWN_CURRENCY','TRANSIENT_DATABASE_FAILURE','AI_DISABLED') or p_transient is null or p_uncertain is null or p_request_id is null or (p_tokens is not null and p_tokens not between 0 and 250000) then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
 update public.ai_jobs set observed_tokens=observed_tokens+coalesce(p_tokens,0),uncertain_usage=uncertain_usage or p_uncertain where id=j.id returning * into j;
 if not private.analysis_allowed(j) then return private.end_analysis(j.id,'CANCELLED','ACCESS_OR_CONTEXT_CHANGED',p_request_id);end if;
 if p_transient and j.attempts<3 then
  update public.ai_jobs set state='QUEUED',lease_token=null,lease_until=null,dispatched_at=null,available_at=now()+make_interval(secs=>30*power(2,attempts-1)::integer+floor(random()*11)::integer),failure_code=p_code,version=version+1 where id=j.id;
  return jsonb_build_object('state','QUEUED');
 end if;return private.end_analysis(j.id,'FAILED',p_code,p_request_id);
end;$$;
create function public.worker_finish_analysis(p_job uuid,p_lease uuid,p_result jsonb,p_tokens integer,p_latency integer,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j public.ai_jobs;l public.leads;result public.ai_analyses;snapshot jsonb;e jsonb;fresh text;
begin
 perform private.require_worker();if p_request_id is null or p_tokens is null or p_tokens not between 0 and 250000 or p_latency is null or p_latency not between 0 and 90000 or jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text)>48000 or p_result->>'rubric_version' is distinct from 'proposed-1' or jsonb_typeof(p_result->'score') is distinct from 'number' or (p_result->>'score')::numeric not between 0 and 100 or p_result->'analysis'->>'schema_version' is distinct from 'analysis-1' or jsonb_typeof(p_result->'analysis'->'field_evidence') is distinct from 'array' then raise exception 'VALIDATION_FAILED';end if;
 select * into j from public.ai_jobs where id=p_job;if not found then return jsonb_build_object('state','STALE');end if;
 perform 1 from public.agencies where id=j.tenant_id for update;select * into j from public.ai_jobs where id=p_job for update;
 if j.state<>'RUNNING' or j.lease_token is distinct from p_lease or j.lease_until<=now() then return jsonb_build_object('state','STALE');end if;
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
create function public.worker_analysis_metrics() returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform private.require_worker();return jsonb_build_object('queued',(select count(*) from public.ai_jobs where state='QUEUED'),'failed',(select count(*) from public.ai_jobs where state='FAILED'),'usage_reconciliation',(select count(*) from public.ai_jobs where usage_state='RECONCILE'),'oldest_queued_seconds',(select coalesce(max(extract(epoch from now()-requested_at)),0) from public.ai_jobs where state='QUEUED'));
end;$$;
create function public.analysis_usage(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);a public.agencies;
begin
 if m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;select * into a from public.agencies where id=p_tenant;
 return jsonb_build_object('daily_limit',a.ai_daily_limit,'monthly_limit',a.ai_monthly_limit,'daily_operations',coalesce((select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='DAY' and period_at=(now() at time zone 'UTC')::date),0),
 'monthly_operations',coalesce((select operations from private.ai_usage_windows where tenant_id=p_tenant and kind='MONTH' and period_at=date_trunc('month',now() at time zone 'UTC')::date),0),'reconciliation',(select count(*) from public.ai_jobs where tenant_id=p_tenant and usage_state='RECONCILE'));
end;$$;
revoke all on function private.analysis_context_changed(),private.analysis_snapshot(public.leads),private.analysis_allowed(public.ai_jobs),private.end_analysis(uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.submit_analysis(uuid,uuid,integer,uuid,uuid),public.cancel_analysis(uuid,uuid,integer,uuid,uuid),public.analysis_usage(uuid) from public,anon;
grant execute on function public.submit_analysis(uuid,uuid,integer,uuid,uuid),public.cancel_analysis(uuid,uuid,integer,uuid,uuid),public.analysis_usage(uuid) to authenticated;
revoke all on function public.worker_set_ai_policy(boolean,text,text[],boolean,uuid),public.worker_claim_analysis(uuid),public.worker_prepare_analysis(uuid,uuid,uuid),public.worker_fail_analysis(uuid,uuid,text,boolean,integer,boolean,uuid),public.worker_finish_analysis(uuid,uuid,jsonb,integer,integer,uuid),public.worker_analysis_metrics() from public,anon,authenticated;
grant execute on function public.worker_set_ai_policy(boolean,text,text[],boolean,uuid),public.worker_claim_analysis(uuid),public.worker_prepare_analysis(uuid,uuid,uuid),public.worker_fail_analysis(uuid,uuid,text,boolean,integer,boolean,uuid),public.worker_finish_analysis(uuid,uuid,jsonb,integer,integer,uuid),public.worker_analysis_metrics() to service_role;
create or replace function public.team_snapshot(p_tenant uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant);agency public.agencies;email text;result jsonb;
begin
 select * into agency from public.agencies where id=p_tenant;select u.email into email from auth.users u where u.id=auth.uid();
 result:=jsonb_build_object('membership',jsonb_build_object('id',member.id,'role',member.role,'version',member.version,'display_name',member.display_name,'email',email),
 'agency',jsonb_build_object('id',agency.id,'name',agency.name,'timezone',agency.timezone,'locale',agency.locale,'version',agency.version,'ai_enabled',agency.ai_enabled,'processing_approved',agency.processing_approved,'processing_reference',case when member.role in ('OWNER','ADMIN') then agency.processing_reference else null end),
 'pilot',case when member.role='OWNER' then jsonb_build_object('seat_limit',agency.seat_limit,'ai_monthly_limit',agency.ai_monthly_limit,'ai_daily_limit',agency.ai_daily_limit,'active_seats',(select count(*) from public.memberships m where m.tenant_id=p_tenant and m.active),'pending_seats',(select count(*) from public.invitations i where i.tenant_id=p_tenant and i.state='PENDING' and i.expires_at>now())) else null end,
 'onboarding',case when member.role in ('OWNER','ADMIN') then jsonb_build_object('Agency details',char_length(agency.name)>=2,'Processing settings',agency.processing_approved,'Invite team',(select exists(select 1 from public.invitations i where i.tenant_id=p_tenant)),'Sample lead',(select exists(select 1 from public.leads l where l.tenant_id=p_tenant)),'Schedule reminder',(select exists(select 1 from public.follow_ups f where f.tenant_id=p_tenant))) else null end);
 return result;
end; $$;
create or replace function public.update_agency_settings(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.writer_member(p_tenant);agency public.agencies;prior private.api_requests;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');v_operation text:='settings:'||p_tenant::text;result jsonb;seats integer;cap integer;daily integer;
begin
 if member.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 perform private.team_payload(p_payload,array['expected_version','name','timezone','locale','processing_approved','processing_reference','ai_enabled','seat_limit','ai_monthly_limit','ai_daily_limit']);
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload->'name') is distinct from 'string' or char_length(trim(p_payload->>'name')) not between 2 and 120
 or p_payload->>'locale' is distinct from 'en' or not exists(select 1 from pg_catalog.pg_timezone_names where name=p_payload->>'timezone')
 or jsonb_typeof(p_payload->'processing_approved') is distinct from 'boolean' or jsonb_typeof(p_payload->'ai_enabled') is distinct from 'boolean'
 or jsonb_typeof(p_payload->'processing_reference') is distinct from 'string' or char_length(p_payload->>'processing_reference')>500
 or (p_payload->'processing_approved'='true'::jsonb and char_length(trim(p_payload->>'processing_reference'))<5) then raise exception 'VALIDATION_FAILED';end if;
 if member.role<>'OWNER' and (p_payload ? 'seat_limit' or p_payload ? 'ai_monthly_limit' or p_payload ? 'ai_daily_limit') then raise exception 'ROLE_REQUIRED';end if;
 select * into prior from private.api_requests r where r.actor_id=auth.uid() and r.operation=v_operation and r.request_key=p_key;
 if found then if prior.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return prior.response;end if;
 select * into agency from public.agencies where id=p_tenant;
 if p_payload->>'expected_version' is distinct from agency.version::text then raise exception 'VERSION_CONFLICT';end if;
 seats:=agency.seat_limit;cap:=agency.ai_monthly_limit;daily:=agency.ai_daily_limit;
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
 if p_payload ? 'ai_daily_limit' then
  if p_payload->'ai_daily_limit'='null'::jsonb then daily:=null;
  elsif jsonb_typeof(p_payload->'ai_daily_limit')='number' and p_payload->>'ai_daily_limit' ~ '^[0-9]{1,7}$' then daily:=(p_payload->>'ai_daily_limit')::integer;if daily not between 0 and 1000000 then raise exception 'VALIDATION_FAILED';end if;
  else raise exception 'VALIDATION_FAILED';end if;
 end if;
 if seats is not null and seats<private.seat_count(p_tenant) then raise exception 'SEAT_LIMIT_REACHED';end if;
 if p_payload->'ai_enabled'='true'::jsonb and (p_payload->'processing_approved'<>'true'::jsonb or cap is null) then raise exception 'PROCESSING_REQUIRED';end if;
 update public.agencies set name=trim(p_payload->>'name'),timezone=p_payload->>'timezone',locale='en',processing_approved=(p_payload->>'processing_approved')::boolean,
 processing_reference=nullif(trim(p_payload->>'processing_reference'),''),ai_enabled=(p_payload->>'ai_enabled')::boolean,seat_limit=seats,ai_monthly_limit=cap,ai_daily_limit=daily,version=version+1 where id=p_tenant returning * into agency;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,auth.uid(),'AGENCY_SETTINGS_UPDATED',p_request_id,jsonb_build_object('agency_version',agency.version,'processing_approved',agency.processing_approved,'ai_enabled',agency.ai_enabled));
 insert into private.outbox_events(tenant_id,event_type,entity_id,dedupe_key,payload) values(p_tenant,'AGENCY_SETTINGS_CHANGED',p_tenant,v_operation||':'||p_key::text,jsonb_build_object('version',agency.version));
 result:=jsonb_build_object('id',agency.id,'version',agency.version);insert into private.api_requests values(auth.uid(),v_operation,p_key,hash,p_tenant,result,now());return result;
end; $$;
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
  return lead.context_version=n.input_version and exists(select 1 from public.ai_jobs j where j.tenant_id=n.tenant_id and j.lead_id=n.lead_id and j.id=n.resource_id and j.requester_member_id=n.recipient_id and j.input_version=n.input_version and (n.type='AI_READY' and j.state='SUCCEEDED' and exists(select 1 from public.ai_analyses a where a.job_id=j.id and a.id=lead.current_analysis_id) or n.type='AI_FAILED' and j.state='FAILED'));
 end if;
 return false;
end; $$;
commit;
