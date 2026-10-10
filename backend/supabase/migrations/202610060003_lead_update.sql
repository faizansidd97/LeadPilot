begin;
create function public.update_lead(p_tenant uuid,p_lead uuid,p_payload jsonb,p_expected_version integer,p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.active_member(p_tenant); lead public.leads; duplicate boolean;
begin
 if p_request_id is null or p_expected_version is null or p_expected_version<1 or p_payload ? 'initial_message' or p_payload ? 'assignee_id' then raise exception 'VALIDATION_FAILED'; end if;
 perform private.validate_lead(p_payload);
 select * into lead from public.leads l where l.tenant_id=p_tenant and l.id=p_lead and (member.role in ('OWNER','ADMIN') or l.assignee_id=member.id) for update;
 if not found then raise exception 'NOT_FOUND'; end if;
 if lead.version<>p_expected_version then raise exception 'VERSION_CONFLICT'; end if;
 if lead.archived_at is not null then raise exception 'CONTACT_BLOCKED'; end if;
 select exists(select 1 from public.leads l where l.tenant_id=p_tenant and l.id<>p_lead and
 ((coalesce(p_payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(p_payload->>'email'))) or
 (coalesce(p_payload->>'phone','')<>'' and l.phone=p_payload->>'phone'))) into duplicate;
 update public.leads set full_name=trim(p_payload->>'full_name'),email=nullif(lower(trim(p_payload->>'email')),''),phone=nullif(p_payload->>'phone',''),
 budget_min=(p_payload->>'budget_min')::numeric,budget_max=(p_payload->>'budget_max')::numeric,currency=p_payload->>'currency',
 duplicate_review=duplicate,version=version+1,context_version=context_version+1
 where id=p_lead and tenant_id=p_tenant returning * into lead;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id) values(p_tenant,p_lead,auth.uid(),'LEAD_UPDATED',p_request_id);
 return to_jsonb(lead);
end; $$;
revoke all on function public.update_lead(uuid,uuid,jsonb,integer,uuid) from public,anon;
grant execute on function public.update_lead(uuid,uuid,jsonb,integer,uuid) to authenticated;
commit;
