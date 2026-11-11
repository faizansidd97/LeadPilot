begin;
-- Disabled until the operator configures an independent immutable manifest store.
create table private.privacy_policy(singleton boolean primary key default true check(singleton),enabled boolean not null default false,version integer not null default 1 check(version>0),history_days integer not null default 30 check(history_days=30));
insert into private.privacy_policy(singleton) values(true);
create table private.privacy_jobs(
 id uuid primary key default gen_random_uuid(),sequence bigint generated always as identity unique,tenant_id uuid not null references public.agencies(id),case_id uuid not null,
 kind text not null check(kind in ('LEAD_ERASURE','AGENCY_CLOSURE')),actor_id uuid not null references auth.users(id),policy_version integer not null,
 request_key uuid not null,payload_hash text not null,case_version integer not null,state text not null default 'PENDING' check(state in ('PENDING','ANONYMIZED','EXPIRED')),
 prepared_at timestamptz not null default statement_timestamp(),completed_at timestamptz,history_expires_at timestamptz,expired_at timestamptz,
 manifest_digest text,lease_token uuid,lease_until timestamptz,attempts integer not null default 0,available_at timestamptz not null default statement_timestamp(),
 unique(tenant_id,case_id),unique(actor_id,request_key),foreign key(tenant_id,case_id) references public.privacy_cases(tenant_id,id));
create index privacy_work_due on private.privacy_jobs(state,available_at,sequence);
create table private.privacy_subjects(tenant_id uuid not null,lead_id uuid not null,job_id uuid not null references private.privacy_jobs(id),original_version integer not null,
 state text not null default 'PENDING' check(state in ('PENDING','ANONYMIZED')),primary key(tenant_id,lead_id),foreign key(tenant_id,lead_id) references public.leads(tenant_id,id));
create index privacy_subject_job on private.privacy_subjects(job_id,state,lead_id);
create table private.privacy_history(job_id uuid primary key references private.privacy_jobs(id),summary jsonb not null check(jsonb_typeof(summary)='object'));
create table private.privacy_context(transaction_id bigint primary key,tenant_id uuid not null,job_id uuid not null);
create table private.privacy_intake_barriers(integration_id uuid not null,event_hash text not null check(event_hash~'^[a-f0-9]{64}$'),job_id uuid not null,primary key(integration_id,event_hash));
create table private.privacy_restore_gate(singleton boolean primary key default true check(singleton),blocked boolean not null default false,checkpoint text,expected_count integer,applied_count integer not null default 0);
insert into private.privacy_restore_gate(singleton) values(true);
create table private.privacy_restore_receipts(checkpoint text not null,job_id uuid not null,digest text not null,primary key(checkpoint,job_id));
do $$declare t text;begin foreach t in array array['privacy_policy','privacy_jobs','privacy_subjects','privacy_history','privacy_context','privacy_intake_barriers','privacy_restore_gate','privacy_restore_receipts'] loop
 execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
end loop;end;$$;
create or replace function private.verified_actor() returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();begin
 if exists(select 1 from private.privacy_restore_gate where blocked) then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
 if actor is null or not exists(select 1 from auth.users where id=actor and email_confirmed_at is not null) then raise exception 'AUTH_REQUIRED';end if;return actor;
end;$$;
create or replace function private.has_membership(p_tenant uuid) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.privacy_restore_gate where blocked) and exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and m.user_id=(select auth.uid()) and m.active and u.email_confirmed_at is not null);
$$;
create or replace function private.can_read_lead(p_tenant uuid,p_assignee uuid) returns boolean language sql stable security definer set search_path='' as $$
 select not exists(select 1 from private.privacy_restore_gate where blocked) and exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and m.user_id=(select auth.uid()) and m.active and u.email_confirmed_at is not null and(m.role in('OWNER','ADMIN')or m.id=p_assignee));
$$;
alter table public.privacy_cases drop constraint privacy_cases_state_check;
alter table public.privacy_cases add constraint privacy_cases_state_check check(state in ('REQUESTED','IN_REVIEW','ON_HOLD','WITHDRAWN','ANONYMIZING','ANONYMIZED','EXPIRED','CLOSED'));

create function private.privacy_internal(p_tenant uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.privacy_context where transaction_id=txid_current() and tenant_id=p_tenant);
$$;
create function private.privacy_hidden(p_tenant uuid,p_lead uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.privacy_subjects where tenant_id=p_tenant and lead_id=p_lead);
$$;
create policy privacy_subject_hidden on public.leads as restrictive for select to authenticated using(not private.privacy_hidden(tenant_id,id));
create function private.privacy_agency_locked(p_tenant uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.privacy_jobs where tenant_id=p_tenant and kind='AGENCY_CLOSURE');
$$;
-- Block pre-existing SECURITY DEFINER read/replay paths while raw data awaits
-- scrubbing. Direct lead SELECTs also have a restrictive subject policy above.
alter function private.active_member(uuid) rename to active_member_before_privacy;
alter function private.read_member(uuid) rename to read_member_before_privacy;
create function private.active_member(p_tenant uuid) returns public.memberships language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member_before_privacy(p_tenant);begin
 if exists(select 1 from private.privacy_jobs where tenant_id=p_tenant and state='PENDING') or private.privacy_agency_locked(p_tenant) then raise exception 'PRIVACY_FROZEN';end if;return m;
end;$$;
create function private.read_member(p_tenant uuid) returns public.memberships language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member_before_privacy(p_tenant);begin
 if exists(select 1 from private.privacy_jobs where tenant_id=p_tenant and state='PENDING') or private.privacy_agency_locked(p_tenant) then raise exception 'PRIVACY_FROZEN';end if;return m;
end;$$;
revoke all on function private.active_member_before_privacy(uuid),private.read_member_before_privacy(uuid),private.active_member(uuid),private.read_member(uuid) from public,anon,authenticated,service_role;
create function private.privacy_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare r jsonb:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;t uuid:=(r->>'tenant_id')::uuid;l uuid;v text;
begin
 if TG_TABLE_NAME='agencies' then t:=(r->>'id')::uuid;end if;
 if TG_TABLE_NAME in ('ai_context','ai_provider_attempts') then select tenant_id,lead_id into t,l from public.ai_jobs where id=(r->>'job_id')::uuid;end if;
 if TG_TABLE_NAME='draft_copy_receipts' then select tenant_id,lead_id into t,l from public.reply_drafts where id=(r->>'draft_id')::uuid;end if;
 if t is null or private.privacy_internal(t) then if TG_OP='DELETE' then return old;else return new;end if;end if;
 if TG_TABLE_NAME='leads' then l:=(r->>'id')::uuid;else v:=r->>'lead_id';if v~*'^[a-f0-9-]{36}$' then l:=v::uuid;end if;end if;
 if TG_TABLE_NAME='outbox_events' then
  v:=r->'payload'->>'lead_id';if v~*'^[a-f0-9-]{36}$' then l:=v::uuid;end if;
  if l is null then select id into l from public.leads where tenant_id=t and id=(r->>'entity_id')::uuid;end if;
  if l is null then select lead_id into l from public.follow_ups where tenant_id=t and id=(r->>'entity_id')::uuid;end if;
 end if;
 perform 1 from public.agencies where id=t for key share;
 if l is not null then perform 1 from public.leads where tenant_id=t and id=l for key share;end if;
 if private.privacy_agency_locked(t) or l is not null and private.privacy_hidden(t,l) or TG_TABLE_NAME in ('lead_imports','lead_import_rows') and exists(select 1 from private.privacy_jobs where tenant_id=t and state='PENDING') then raise exception 'PRIVACY_FROZEN';end if;
 if TG_OP='UPDATE' and TG_TABLE_NAME in ('messages','follow_ups','ai_jobs','reply_drafts','message_revisions','draft_feedback') and (to_jsonb(old)->>'tenant_id',to_jsonb(old)->>'lead_id') is distinct from (r->>'tenant_id',r->>'lead_id') then raise exception 'PRIVACY_FROZEN';end if;
 if TG_OP='DELETE' then return old;else return new;end if;
end;$$;
create function private.privacy_case_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not private.privacy_internal(old.tenant_id) and exists(select 1 from private.privacy_jobs where tenant_id=old.tenant_id and case_id=old.id) then raise exception 'PRIVACY_FROZEN';end if;return new;
end;$$;
create trigger privacy_terminal_case before update on public.privacy_cases for each row execute function private.privacy_case_guard();
drop trigger lead_notice_event on public.leads;
create trigger lead_notice_event after insert or update on public.leads for each row when(not private.privacy_internal(new.tenant_id)) execute function private.capture_notification_event();
do $$declare t text;ns text;begin
 foreach t in array array['leads','messages','message_revisions','follow_ups','activity_events','ai_jobs','ai_analyses','reply_drafts','draft_feedback','notifications','agencies','memberships','invitations','ai_context','ai_provider_attempts','draft_copy_receipts','outbox_events','lead_imports','lead_import_rows','website_integrations'] loop
  ns:=case when t in ('ai_context','ai_provider_attempts','draft_copy_receipts','outbox_events','lead_imports','lead_import_rows','website_integrations') then 'private' else 'public' end;
  execute format('create trigger privacy_write_guard before insert or update or delete on %I.%I for each row execute function private.privacy_guard()',ns,t);
 end loop;
end;$$;

create function private.privacy_manifest(p_job uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('format_version',1,'job_id',j.id,'sequence',j.sequence,'tenant_id',j.tenant_id,'case_id',j.case_id,'kind',j.kind,'policy_version',j.policy_version,
 'prepared_at',to_char(j.prepared_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'lead_ids',coalesce((select jsonb_agg(s.lead_id order by s.lead_id) from private.privacy_subjects s where s.job_id=j.id),'[]'::jsonb)) from private.privacy_jobs j where j.id=p_job;
$$;
create function private.privacy_assert_quiet(p_tenant uuid,p_leads uuid[],p_agency boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.ai_jobs where tenant_id=p_tenant and (p_agency or lead_id=any(p_leads)) and (state in ('QUEUED','RUNNING') or usage_state in ('RESERVED','RECONCILE') or uncertain_usage)) then raise exception 'PRIVACY_PROCESSING_PENDING';end if;
 if exists(select 1 from private.outbox_events where tenant_id=p_tenant and state='RUNNING' and (p_agency or entity_id=any(p_leads) or payload->>'lead_id'=any(select x::text from unnest(p_leads) x) or entity_id in(select id from public.follow_ups where tenant_id=p_tenant and lead_id=any(p_leads)))) then raise exception 'PRIVACY_PROCESSING_PENDING';end if;
 if not p_agency and exists(select 1 from private.lead_import_rows where tenant_id=p_tenant and lead_id is null and (payload is not null or errors<>'{}'::jsonb)) then raise exception 'PRIVACY_IMPORT_REVIEW_REQUIRED';end if;
 if exists(select 1 from public.privacy_cases where tenant_id=p_tenant and state='ON_HOLD' and (p_agency or lead_id is null or lead_id=any(p_leads))) then raise exception 'PRIVACY_ON_HOLD';end if;
end;$$;

create function public.prepare_privacy_execution(p_tenant uuid,p_case uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member_before_privacy(p_tenant);c public.privacy_cases;j private.privacy_jobs;pol private.privacy_policy;ids uuid[];l record;hash text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if m.role<>'OWNER' then raise exception 'ROLE_REQUIRED';end if;perform private.require_recent_mfa();
 perform private.enforce_write_limit(m.user_id);
 perform private.team_payload(p_payload,array['expected_case_version','expected_subject_version','expected_policy_version','confirm']);
 if p_key is null or p_request_id is null or p_payload->>'confirm' is distinct from 'ANONYMIZE' or jsonb_typeof(p_payload->'expected_case_version') is distinct from 'number' or jsonb_typeof(p_payload->'expected_subject_version') is distinct from 'number' or jsonb_typeof(p_payload->'expected_policy_version') is distinct from 'number' then raise exception 'VALIDATION_FAILED';end if;
 perform pg_advisory_xact_lock(hashtextextended('privacy:'||p_tenant::text,0));
 select * into c from public.privacy_cases where tenant_id=p_tenant and id=p_case for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into j from private.privacy_jobs where tenant_id=p_tenant and case_id=p_case;
 if found then if j.actor_id<>m.user_id or j.request_key<>p_key or j.payload_hash<>hash then raise exception 'IDEMPOTENCY_CONFLICT';end if;return jsonb_build_object('id',j.id,'state',j.state,'case_id',j.case_id);end if;
 if c.version::numeric<>(p_payload->>'expected_case_version')::numeric then raise exception 'VERSION_CONFLICT';end if;
 select * into pol from private.privacy_policy where singleton for share;
 if not pol.enabled then raise exception 'PRIVACY_DISABLED';end if;
 if pol.version::numeric<>(p_payload->>'expected_policy_version')::numeric then raise exception 'VERSION_CONFLICT';end if;
 if c.state<>'IN_REVIEW' or c.verification_reference is null then raise exception 'STATE_CONFLICT';end if;
 perform 1 from public.agencies where id=p_tenant for update;
 if c.kind='LEAD_ERASURE' then
  perform 1 from public.leads where tenant_id=p_tenant and id=c.lead_id and version::numeric=(p_payload->>'expected_subject_version')::numeric for update;
  if not found then raise exception 'VERSION_CONFLICT';end if;ids:=array[c.lead_id];
 else
  if not exists(select 1 from public.agencies where id=p_tenant and version::numeric=(p_payload->>'expected_subject_version')::numeric) then raise exception 'VERSION_CONFLICT';end if;
  for l in select id from public.leads where tenant_id=p_tenant order by id for update loop end loop;
  select coalesce(array_agg(id order by id),'{}') into ids from public.leads where tenant_id=p_tenant;
 end if;
 if cardinality(ids)>10000 then raise exception 'PRIVACY_SCOPE_TOO_LARGE';end if;
 if exists(select 1 from private.privacy_subjects where tenant_id=p_tenant and lead_id=any(ids) and (c.kind='LEAD_ERASURE' or state='PENDING')) or private.privacy_agency_locked(p_tenant) then raise exception 'PRIVACY_FROZEN';end if;
 perform private.privacy_assert_quiet(p_tenant,ids,c.kind='AGENCY_CLOSURE');
 insert into private.privacy_jobs(tenant_id,case_id,kind,actor_id,policy_version,request_key,payload_hash,case_version) values(p_tenant,p_case,c.kind,m.user_id,pol.version,p_key,hash,c.version+1) returning * into j;
 insert into private.privacy_context values(txid_current(),p_tenant,j.id);
 insert into private.privacy_subjects(tenant_id,lead_id,job_id,original_version) select p_tenant,id,j.id,version from public.leads where tenant_id=p_tenant and id=any(ids) on conflict(tenant_id,lead_id) do update set job_id=excluded.job_id,state='PENDING';
 -- Freeze queued notices immediately so a broad worker claim cannot block other tenants.
 update private.outbox_events set state='CANCELLED',lease_token=null,lease_until=null,completed_at=statement_timestamp(),last_error_code='PRIVACY_FROZEN'
 where tenant_id=p_tenant and state<>'RUNNING' and (c.kind='AGENCY_CLOSURE' or entity_id=any(ids) or payload->>'lead_id'=any(select x::text from unnest(ids) x) or entity_id in(select id from public.follow_ups where tenant_id=p_tenant and lead_id=any(ids)));
 update public.follow_ups set state='CANCELLED',cancel_reason='Privacy request',version=version+1,schedule_version=schedule_version+1 where tenant_id=p_tenant and lead_id=any(ids) and state='OPEN';
 update public.privacy_cases set state='ANONYMIZING',version=version+1,updated_at=statement_timestamp() where id=p_case;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,c.lead_id,m.user_id,'PRIVACY_PREPARED',p_request_id,jsonb_build_object('case_id',p_case,'job_id',j.id));
 delete from private.privacy_context where transaction_id=txid_current();
 return jsonb_build_object('id',j.id,'state',j.state,'case_id',j.case_id);
end;$$;

-- All cleanup runs in the same transaction as its scoped private context. The
-- context table is not writable by any API/worker role; no caller GUC can bypass it.
create function private.privacy_scrub_lead(p_job uuid,p_lead uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.privacy_jobs;l public.leads;ids text[];summary jsonb;
begin
 select * into j from private.privacy_jobs where id=p_job;
 if not private.privacy_internal(j.tenant_id) then raise exception 'WORKER_REQUIRED';end if;
 select * into l from public.leads where tenant_id=j.tenant_id and id=p_lead for update;if not found then raise exception 'NOT_FOUND';end if;
 select array_agg(x) into ids from (
 select p_lead::text x union select id::text from public.messages where tenant_id=j.tenant_id and lead_id=p_lead
 union select id::text from public.follow_ups where tenant_id=j.tenant_id and lead_id=p_lead
 union select id::text from public.ai_jobs where tenant_id=j.tenant_id and lead_id=p_lead
 union select id::text from public.reply_drafts where tenant_id=j.tenant_id and lead_id=p_lead
 union select import_id::text from private.lead_import_rows where tenant_id=j.tenant_id and lead_id=p_lead
 union select id::text from public.privacy_cases where tenant_id=j.tenant_id and lead_id=p_lead) q;
 summary:=jsonb_build_object('leads',1,'messages',(select count(*) from public.messages where tenant_id=j.tenant_id and lead_id=p_lead),
 'tasks',(select count(*) from public.follow_ups where tenant_id=j.tenant_id and lead_id=p_lead));
 -- Keep the replay key/hash tombstone, never the prior customer response.
 update private.api_requests r set response='{"privacy_redacted":true}' where tenant_id=j.tenant_id and exists(select 1 from unnest(ids) x where position(x in r.operation)>0 or position(x in r.response::text)>0);
 delete from private.draft_copy_receipts where tenant_id=j.tenant_id and draft_id in(select id from public.reply_drafts where tenant_id=j.tenant_id and lead_id=p_lead);
 delete from public.draft_feedback where tenant_id=j.tenant_id and lead_id=p_lead;
 delete from public.reply_drafts where tenant_id=j.tenant_id and lead_id=p_lead;
 update public.leads set current_analysis_id=null where tenant_id=j.tenant_id and id=p_lead;
 delete from public.ai_analyses where tenant_id=j.tenant_id and lead_id=p_lead;
 delete from private.ai_context where job_id in(select id from public.ai_jobs where tenant_id=j.tenant_id and lead_id=p_lead);
 delete from private.ai_provider_attempts where job_id in(select id from public.ai_jobs where tenant_id=j.tenant_id and lead_id=p_lead);
 delete from public.ai_jobs where tenant_id=j.tenant_id and lead_id=p_lead;
 delete from public.message_revisions where tenant_id=j.tenant_id and lead_id=p_lead;
 delete from public.messages where tenant_id=j.tenant_id and lead_id=p_lead;
 delete from public.notifications where tenant_id=j.tenant_id and (lead_id=p_lead or resource_id=p_lead or task_id in(select id from public.follow_ups where tenant_id=j.tenant_id and lead_id=p_lead));
 delete from private.outbox_events where tenant_id=j.tenant_id and (entity_id=p_lead or payload->>'lead_id'=p_lead::text or entity_id in(select id from public.follow_ups where tenant_id=j.tenant_id and lead_id=p_lead));
 delete from public.follow_ups where tenant_id=j.tenant_id and lead_id=p_lead;
 update private.lead_imports set reason=null where tenant_id=j.tenant_id and id in(select import_id from private.lead_import_rows where tenant_id=j.tenant_id and lead_id=p_lead);
 update private.lead_import_rows set payload=null,errors='{}',state='INVALID',attempts=3 where tenant_id=j.tenant_id and lead_id=p_lead;
 -- Preserve only a one-way replay barrier, not the website's external identifier.
 insert into private.privacy_intake_barriers select integration_id,encode(sha256(convert_to(external_event_id,'UTF8')),'hex'),p_job from private.intake_events where tenant_id=j.tenant_id and lead_id=p_lead on conflict do nothing;
 delete from private.intake_events where tenant_id=j.tenant_id and lead_id=p_lead;
 delete from public.activity_events where tenant_id=j.tenant_id and (lead_id=p_lead or exists(select 1 from unnest(ids) x where position(x in details::text)>0));
 update public.privacy_case_actions set reason='Privacy content removed' where tenant_id=j.tenant_id and case_id in(select id from public.privacy_cases where tenant_id=j.tenant_id and lead_id=p_lead);
 update public.privacy_cases set reason='Privacy content removed',verification_reference=null,hold_reason=null where tenant_id=j.tenant_id and lead_id=p_lead and state<>'ON_HOLD';
 -- An inaccessible constant shell keeps FK and late-write tombstones without contact data.
 update public.leads set full_name='Anonymous record',email='redacted@example.invalid',phone=null,assignee_id=null,do_not_contact=true,archived_at=statement_timestamp(),
 status='LOST',budget_min=null,budget_max=null,currency=null,duplicate_review=false,confirmed_intent=null,qualification_summary=null,locations='{}',qualification_unknowns_ack=false,
 won_at=null,outcome_summary=null,deal_value=null,deal_currency=null,lost_reason=null,outcome_reason=null,budget_period='UNKNOWN',property_type=null,bedrooms=null,purchase_timeline=null,source_reference=null,notes='',reported_facts='{}',facts_confirmed_at=null,
 version=version+1,context_version=context_version+1 where tenant_id=j.tenant_id and id=p_lead;
 update private.privacy_subjects set state='ANONYMIZED' where job_id=p_job and lead_id=p_lead;
 return summary;
end;$$;

create function public.worker_claim_privacy() returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.privacy_jobs;begin
 perform private.require_worker();
 select * into j from private.privacy_jobs where state='PENDING' and available_at<=statement_timestamp() and (lease_until is null or lease_until<=statement_timestamp()) order by sequence limit 1 for update skip locked;
 if not found then return null;end if;
 update private.privacy_jobs set lease_token=gen_random_uuid(),lease_until=statement_timestamp()+interval '60 seconds',attempts=attempts+1,available_at=statement_timestamp()+interval '60 seconds' where id=j.id returning * into j;
 return jsonb_build_object('id',j.id,'lease',j.lease_token,'manifest_text',private.privacy_manifest(j.id)::text);
end;$$;

create function public.worker_apply_privacy(p_job uuid,p_lease uuid,p_manifest_digest text) returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.privacy_jobs;s record;v jsonb;old_summary jsonb;ids uuid[];n integer:=0;
begin
 perform private.require_worker();select * into j from private.privacy_jobs where id=p_job for update;
 if not found or j.state<>'PENDING' or j.lease_token is distinct from p_lease or j.lease_until<=statement_timestamp() then return jsonb_build_object('state','STALE','processed',0);end if;
 if p_manifest_digest is distinct from encode(sha256(convert_to(private.privacy_manifest(j.id)::text,'UTF8')),'hex') or j.manifest_digest is not null and j.manifest_digest<>p_manifest_digest then raise exception 'PRIVACY_MANIFEST_REQUIRED';end if;
 perform 1 from public.agencies where id=j.tenant_id for update;
 select coalesce(array_agg(lead_id),'{}') into ids from private.privacy_subjects where job_id=j.id;
 perform private.privacy_assert_quiet(j.tenant_id,ids,j.kind='AGENCY_CLOSURE');
 if not exists(select 1 from public.privacy_cases where tenant_id=j.tenant_id and id=j.case_id and state='ANONYMIZING' and version=j.case_version) then raise exception 'STATE_CONFLICT';end if;
 insert into private.privacy_context values(txid_current(),j.tenant_id,j.id);
 select summary into old_summary from private.privacy_history where job_id=j.id;old_summary:=coalesce(old_summary,'{"leads":0,"messages":0,"tasks":0}'::jsonb);
 for s in select lead_id from private.privacy_subjects where job_id=j.id and state='PENDING' order by lead_id limit 25 loop
  v:=private.privacy_scrub_lead(j.id,s.lead_id);n:=n+1;
  old_summary:=jsonb_build_object('leads',(old_summary->>'leads')::bigint+(v->>'leads')::bigint,'messages',(old_summary->>'messages')::bigint+(v->>'messages')::bigint,'tasks',(old_summary->>'tasks')::bigint+(v->>'tasks')::bigint);
 end loop;
 insert into private.privacy_history values(j.id,old_summary) on conflict(job_id) do update set summary=excluded.summary;
 update private.privacy_jobs set manifest_digest=p_manifest_digest,lease_token=null,lease_until=null,available_at=statement_timestamp() where id=j.id;
 if not exists(select 1 from private.privacy_subjects where job_id=j.id and state='PENDING') then
  if j.kind='AGENCY_CLOSURE' then
   delete from public.notifications where tenant_id=j.tenant_id;
   delete from private.outbox_events where tenant_id=j.tenant_id;
   update private.lead_import_rows set payload=null,errors='{}',state='INVALID',attempts=3 where tenant_id=j.tenant_id;
   update private.lead_imports set reason=null,state='COMPLETE' where tenant_id=j.tenant_id;
   update private.website_integrations set active=false,secret_cipher='',secret_aad='',name='Closed integration',version=version+1,key_version=key_version+1 where tenant_id=j.tenant_id;
   update public.invitations set email='redacted@example.invalid',token_hash=encode(sha256(convert_to(id::text,'UTF8')),'hex'),state='REVOKED',version=version+1 where tenant_id=j.tenant_id;
   update public.memberships set active=false,display_name=null,deactivated_at=statement_timestamp(),version=version+1 where tenant_id=j.tenant_id;
   update public.agencies set name='Closed agency',ai_enabled=false,processing_approved=false,processing_reference=null,version=version+1 where id=j.tenant_id;
   update private.api_requests set response='{"privacy_redacted":true}' where tenant_id=j.tenant_id;
   delete from public.activity_events where tenant_id=j.tenant_id;
   update public.privacy_case_actions set reason='Privacy content removed' where tenant_id=j.tenant_id;
   update public.privacy_cases set reason='Privacy content removed',verification_reference=null,hold_reason=null,state=case when id=j.case_id then 'CLOSED' else 'WITHDRAWN' end,version=version+1,updated_at=statement_timestamp() where tenant_id=j.tenant_id;
  else
   update public.privacy_cases set state='ANONYMIZED',version=version+1,updated_at=statement_timestamp() where id=j.case_id;
  end if;
  update private.privacy_jobs set state='ANONYMIZED',completed_at=statement_timestamp(),history_expires_at=statement_timestamp()+interval '30 days' where id=j.id;
 end if;
 delete from private.privacy_context where transaction_id=txid_current();
 select * into j from private.privacy_jobs where id=p_job;
 return jsonb_build_object('state',j.state,'processed',n);
end;$$;

create function public.worker_expire_privacy() returns jsonb language plpgsql security definer set search_path='' as $$
declare j private.privacy_jobs;n integer:=0;begin
 perform private.require_worker();
 for j in select * from private.privacy_jobs where state='ANONYMIZED' and history_expires_at<=statement_timestamp() order by history_expires_at limit 25 for update skip locked loop
  insert into private.privacy_context values(txid_current(),j.tenant_id,j.id);
  delete from private.privacy_history where job_id=j.id;
  update private.privacy_jobs set state='EXPIRED',expired_at=statement_timestamp() where id=j.id;
  update public.privacy_cases set state=case when kind='AGENCY_CLOSURE' then 'CLOSED' else 'EXPIRED' end,version=version+1,updated_at=statement_timestamp() where id=j.case_id;
  delete from private.privacy_context where transaction_id=txid_current();
  n:=n+1;
 end loop;return jsonb_build_object('expired',n);
end;$$;

-- Replayed opaque website event IDs cannot recreate an erased customer.
create function private.privacy_intake_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from private.privacy_intake_barriers where integration_id=new.integration_id and event_hash=encode(sha256(convert_to(new.external_event_id,'UTF8')),'hex')) then raise exception 'PRIVACY_FROZEN';end if;return new;
end;$$;
create trigger privacy_intake_replay before insert or update on private.intake_events for each row execute function private.privacy_intake_guard();

revoke all on function private.privacy_internal(uuid),private.privacy_hidden(uuid,uuid),private.privacy_agency_locked(uuid),private.privacy_guard(),private.privacy_manifest(uuid),private.privacy_assert_quiet(uuid,uuid[],boolean),private.privacy_scrub_lead(uuid,uuid),private.privacy_intake_guard() from public,anon,authenticated,service_role;
revoke all on function private.privacy_case_guard() from public,anon,authenticated,service_role;
grant execute on function private.privacy_hidden(uuid,uuid) to authenticated;
revoke all on function public.worker_claim_privacy(),public.worker_apply_privacy(uuid,uuid,text),public.worker_expire_privacy() from public,anon,authenticated,service_role;
grant execute on function public.worker_claim_privacy(),public.worker_apply_privacy(uuid,uuid,text),public.worker_expire_privacy() to service_role;

create function public.read_privacy_execution(p_tenant uuid,p_case uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member_before_privacy(p_tenant);j private.privacy_jobs;pol private.privacy_policy;
begin
 if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if not exists(select 1 from public.privacy_cases where tenant_id=p_tenant and id=p_case) then raise exception 'NOT_FOUND';end if;
 select * into pol from private.privacy_policy where singleton;select * into j from private.privacy_jobs where tenant_id=p_tenant and case_id=p_case;
 return jsonb_build_object('policy_enabled',pol.enabled,'policy_version',pol.version,'history_days',pol.history_days,'job',case when j.id is null then null else jsonb_build_object('id',j.id,'state',j.state,'prepared_at',j.prepared_at,'completed_at',j.completed_at,'history_expires_at',j.history_expires_at,'expired_at',j.expired_at,
 'total',(select count(*) from private.privacy_subjects where job_id=j.id),'processed',(select count(*) from private.privacy_subjects where job_id=j.id and state='ANONYMIZED')) end,'history',(select summary from private.privacy_history where job_id=j.id and j.history_expires_at>statement_timestamp()));
end;$$;
create or replace function public.list_privacy_cases(p_tenant uuid,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns setof public.privacy_cases language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member_before_privacy(p_tenant);begin
 if m.role not in('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if (p_cursor_time is null)<>(p_cursor_id is null) then raise exception 'VALIDATION_FAILED';end if;
 return query select c.* from public.privacy_cases c where c.tenant_id=p_tenant and(p_cursor_time is null or(c.created_at,c.id)<(p_cursor_time,p_cursor_id)) order by c.created_at desc,c.id desc limit 26;
end;$$;

create function public.worker_privacy_restore_begin(p_checkpoint text,p_count integer) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.require_worker();
 if p_checkpoint is null or p_checkpoint!~'^[a-f0-9]{64}$' or p_count is null or p_count<0 or p_count>10000 then raise exception 'VALIDATION_FAILED';end if;
 if exists(select 1 from private.privacy_restore_gate where blocked and checkpoint<>p_checkpoint) then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
 update private.privacy_restore_gate set blocked=true,checkpoint=p_checkpoint,expected_count=p_count,applied_count=(select count(*) from private.privacy_restore_receipts where checkpoint=p_checkpoint);
 return jsonb_build_object('blocked',true);
end;$$;
create function public.worker_privacy_restore_apply(p_checkpoint text,p_manifest_text text) returns jsonb language plpgsql security definer set search_path='' as $$
<<restore_work>>
declare doc jsonb:=p_manifest_text::jsonb;j private.privacy_jobs;tenant uuid:=(doc->>'tenant_id')::uuid;owner_id uuid;ids uuid[];l uuid;case_id uuid:=(doc->>'case_id')::uuid;job_id uuid:=(doc->>'job_id')::uuid;digest text:=encode(sha256(convert_to(p_manifest_text,'UTF8')),'hex');
begin
 perform private.require_worker();perform 1 from private.privacy_restore_gate where blocked and checkpoint=p_checkpoint for update;if not found then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
 if exists(select 1 from private.privacy_restore_receipts where checkpoint=p_checkpoint and privacy_restore_receipts.job_id=restore_work.job_id and privacy_restore_receipts.digest=restore_work.digest) then return jsonb_build_object('applied',true);end if;
 select array_agg(value::uuid) into ids from jsonb_array_elements_text(doc->'lead_ids');ids:=coalesce(ids,'{}');
 if doc->>'format_version'<>'1' or doc->>'kind' not in('LEAD_ERASURE','AGENCY_CLOSURE') or cardinality(ids)>10000 then raise exception 'VALIDATION_FAILED';end if;
 if exists(select 1 from public.agencies where id=tenant) then
  select user_id into owner_id from public.memberships where tenant_id=tenant and role='OWNER' order by active desc limit 1;if owner_id is null then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
  perform 1 from public.agencies where id=tenant for update;
  select * into j from private.privacy_jobs where id=job_id;
  if found and (j.tenant_id<>tenant or j.case_id<>case_id) then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
  -- Existing terminal jobs are replayed too: restored child copies may be older.
  insert into private.privacy_context values(txid_current(),tenant,job_id);
  foreach l in array ids loop
   if exists(select 1 from public.leads where id=l and tenant_id<>tenant) then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
   insert into public.leads(id,tenant_id,full_name,email,source,created_by,do_not_contact,archived_at) values(l,tenant,'Anonymous record','redacted@example.invalid','MANUAL',owner_id,true,statement_timestamp()) on conflict(id) do nothing;
  end loop;
  insert into public.privacy_cases(id,tenant_id,kind,lead_id,reason,requested_by,state) values(case_id,tenant,doc->>'kind',case when doc->>'kind'='LEAD_ERASURE' then ids[1] end,'Privacy restore replay',owner_id,'ANONYMIZING') on conflict(id) do nothing;
  if not exists(select 1 from public.privacy_cases where id=case_id and tenant_id=tenant and kind=doc->>'kind') then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
  if j.id is null then
   insert into private.privacy_jobs(id,tenant_id,case_id,kind,actor_id,policy_version,request_key,payload_hash,case_version,prepared_at) values(job_id,tenant,case_id,doc->>'kind',owner_id,(doc->>'policy_version')::integer,job_id,digest,1,(doc->>'prepared_at')::timestamptz) returning * into j;
  end if;
  if doc->>'kind'='AGENCY_CLOSURE' then select coalesce(array_agg(id),'{}') into ids from public.leads where tenant_id=tenant;end if;
  insert into private.privacy_subjects(tenant_id,lead_id,job_id,original_version) select tenant,id,job_id,version from public.leads where tenant_id=tenant and id=any(ids) on conflict(tenant_id,lead_id) do update set state='PENDING';
  -- Restore is performed offline: cancel stale jobs without dispatching/reconciling providers.
  update public.ai_jobs set state='CANCELLED',lease_token=null,lease_until=null,usage_state='RELEASED',uncertain_usage=false where tenant_id=tenant and lead_id=any(ids);
  update private.outbox_events set state='CANCELLED',lease_token=null,lease_until=null where tenant_id=tenant and (doc->>'kind'='AGENCY_CLOSURE' or entity_id=any(ids) or payload->>'lead_id'=any(select x::text from unnest(ids)x));
  foreach l in array ids loop perform private.privacy_scrub_lead(job_id,l);end loop;
  -- Never recreate the 30-day anonymous history when restoring; it may have expired.
  delete from private.privacy_history where privacy_history.job_id=restore_work.job_id;
  update private.privacy_jobs set state='EXPIRED',manifest_digest=digest,lease_token=null,lease_until=null,expired_at=statement_timestamp() where id=job_id;
  update public.privacy_cases set reason='Privacy content removed',verification_reference=null,hold_reason=null,state=case when kind='AGENCY_CLOSURE' then 'CLOSED' else 'EXPIRED' end,version=version+1 where id=case_id;
  if doc->>'kind'='AGENCY_CLOSURE' then
   delete from public.notifications where tenant_id=tenant;delete from private.outbox_events where tenant_id=tenant;
   update private.lead_import_rows set payload=null,errors='{}',state='INVALID',attempts=3 where tenant_id=tenant;
   update private.lead_imports set reason=null,state='COMPLETE' where tenant_id=tenant;
   update private.website_integrations set active=false,secret_cipher='',secret_aad='',name='Closed integration',version=version+1,key_version=key_version+1 where tenant_id=tenant;
   update public.invitations set email='redacted@example.invalid',state='REVOKED',token_hash=encode(sha256(convert_to(id::text,'UTF8')),'hex'),version=version+1 where tenant_id=tenant;
   update public.memberships set active=false,display_name=null,version=version+1 where tenant_id=tenant;
   update public.agencies set name='Closed agency',ai_enabled=false,processing_approved=false,processing_reference=null,version=version+1 where id=tenant;
   update private.api_requests set response='{"privacy_redacted":true}' where tenant_id=tenant;
   delete from public.activity_events where tenant_id=tenant;
   update public.privacy_case_actions set reason='Privacy content removed' where tenant_id=tenant;
   update public.privacy_cases set reason='Privacy content removed',verification_reference=null,hold_reason=null,state='CLOSED',version=version+1 where tenant_id=tenant;
  end if;
  delete from private.privacy_context where transaction_id=txid_current();
 end if;
 insert into private.privacy_restore_receipts values(p_checkpoint,job_id,digest);
 update private.privacy_restore_gate set applied_count=(select count(*) from private.privacy_restore_receipts where checkpoint=p_checkpoint);
 return jsonb_build_object('applied',true);
end;$$;
create function public.worker_privacy_restore_finish(p_checkpoint text) returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.require_worker();
 perform 1 from private.privacy_restore_gate where blocked and checkpoint=p_checkpoint and applied_count=expected_count for update;
 if not found then raise exception 'PRIVACY_RESTORE_REQUIRED';end if;
 update private.privacy_restore_gate set blocked=false;return jsonb_build_object('blocked',false);
end;$$;
revoke all on function public.worker_privacy_restore_begin(text,integer),public.worker_privacy_restore_apply(text,text),public.worker_privacy_restore_finish(text) from public,anon,authenticated,service_role;
grant execute on function public.worker_privacy_restore_begin(text,integer),public.worker_privacy_restore_apply(text,text),public.worker_privacy_restore_finish(text) to service_role;
revoke all on function public.prepare_privacy_execution(uuid,uuid,jsonb,uuid,uuid),public.read_privacy_execution(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_privacy_execution(uuid,uuid,jsonb,uuid,uuid),public.read_privacy_execution(uuid,uuid) to authenticated;
commit;
