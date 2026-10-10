begin;
-- Current manager relationship inventory; no purge plan or mutation authority.
create function public.read_privacy_impact(p_tenant uuid,p_case uuid,p_expected_version integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.read_member(p_tenant);c public.privacy_cases;
 subject_version integer;holds bigint;active_jobs bigint;reconcile_jobs bigint;open_tasks bigint;
begin
 if m.role not in ('OWNER','ADMIN') then raise exception 'ROLE_REQUIRED';end if;
 if p_case is null or p_expected_version is null or p_expected_version<1 then raise exception 'VALIDATION_FAILED';end if;
 select * into c from public.privacy_cases where tenant_id=p_tenant and id=p_case;
 if not found then raise exception 'NOT_FOUND';end if;
 if c.version<>p_expected_version then raise exception 'VERSION_CONFLICT';end if;
 if c.kind='LEAD_ERASURE' then
  select l.version into subject_version from public.leads l where l.tenant_id=p_tenant and l.id=c.lead_id;
 else
  select a.version into subject_version from public.agencies a where a.id=p_tenant;
 end if;
 if subject_version is null then raise exception 'NOT_FOUND';end if;
 select count(*) into holds from public.privacy_cases r where r.tenant_id=p_tenant and r.state='ON_HOLD'
  and (c.kind='AGENCY_CLOSURE' or r.kind='AGENCY_CLOSURE' or r.lead_id=c.lead_id);
 select count(*) filter(where j.state in ('QUEUED','RUNNING')),count(*) filter(where j.usage_state='RECONCILE')
  into active_jobs,reconcile_jobs from public.ai_jobs j where j.tenant_id=p_tenant and (c.lead_id is null or j.lead_id=c.lead_id);
 select count(*) into open_tasks from public.follow_ups f where f.tenant_id=p_tenant and f.state='OPEN' and (c.lead_id is null or f.lead_id=c.lead_id);
 return jsonb_build_object('tenant_id',p_tenant,'case_id',c.id,'case_version',c.version,'case_state',c.state,
  'kind',c.kind,'lead_id',c.lead_id,'subject_version',subject_version,'as_of',statement_timestamp(),
  'identity_verification_recorded',c.verification_reference is not null,'intersecting_holds',holds,
  'open_tasks',open_tasks,'active_ai_jobs',active_jobs,'reconcile_ai_jobs',reconcile_jobs,
  'retention_policy_approved',false,'inventory_complete',false,'execution_available',false,
  'counts',jsonb_build_object(
   'leads',(select count(*) from public.leads r where r.tenant_id=p_tenant and (c.lead_id is null or r.id=c.lead_id)),
   'messages',(select count(*) from public.messages r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'message_revisions',(select count(*) from public.message_revisions r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'follow_ups',(select count(*) from public.follow_ups r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'activity_events',(select count(*) from public.activity_events r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'ai_jobs',(select count(*) from public.ai_jobs r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'ai_analyses',(select count(*) from public.ai_analyses r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'reply_drafts',(select count(*) from public.reply_drafts r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'draft_feedback',(select count(*) from public.draft_feedback r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'notifications',(select count(*) from public.notifications r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'privacy_cases',(select count(*) from public.privacy_cases r where r.tenant_id=p_tenant and (c.lead_id is null or r.lead_id=c.lead_id)),
   'privacy_case_actions',(select count(*) from public.privacy_case_actions r join public.privacy_cases parent on parent.tenant_id=r.tenant_id and parent.id=r.case_id where r.tenant_id=p_tenant and (c.lead_id is null or parent.lead_id=c.lead_id))));
end;$$;
revoke all on function public.read_privacy_impact(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_privacy_impact(uuid,uuid,integer) to authenticated;
commit;
