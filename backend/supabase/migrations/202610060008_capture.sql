begin;
alter table public.leads add column budget_period text not null default 'UNKNOWN' check(budget_period in ('MONTH','YEAR','TOTAL','UNKNOWN')),
 add column property_type text check(char_length(property_type)<=120),add column bedrooms integer check(bedrooms between 0 and 50),
 add column purchase_timeline text check(char_length(purchase_timeline)<=500),add column source_reference text check(char_length(source_reference)<=500),
 add column notes text not null default '' check(char_length(notes)<=2000),add column reported_facts jsonb not null default '{}' check(jsonb_typeof(reported_facts)='object');
alter table public.messages add constraint message_parent_unique unique(tenant_id,lead_id,id);
alter table public.messages add column version integer not null default 1 check(version>0),add column source_reference text,add column ingested_at timestamptz;
create table public.message_revisions(id uuid primary key default gen_random_uuid(),tenant_id uuid not null,lead_id uuid not null,message_id uuid not null,
 previous_body text not null,revision integer not null,reason text not null check(char_length(trim(reason)) between 5 and 500),actor_id uuid not null references auth.users(id),created_at timestamptz not null default now(),
 foreign key(tenant_id,lead_id) references public.leads(tenant_id,id),foreign key(tenant_id,lead_id,message_id) references public.messages(tenant_id,lead_id,id),unique(tenant_id,message_id,revision));
alter table public.message_revisions enable row level security;
create policy revision_read on public.message_revisions for select to authenticated using(exists(select 1 from public.leads l where l.tenant_id=message_revisions.tenant_id and l.id=message_revisions.lead_id));
revoke all on public.message_revisions from public,anon,authenticated;grant select on public.message_revisions to authenticated;
create index message_revision_history on public.message_revisions(tenant_id,message_id,revision desc);

alter function private.validate_lead(jsonb) rename to validate_lead_core;
create function private.validate_facts(p jsonb) returns void language plpgsql set search_path='' as $$
declare v jsonb;k text;
begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'confirmed_intent' and p->'confirmed_intent'<>'null'::jsonb and (jsonb_typeof(p->'confirmed_intent')<>'string' or p->>'confirmed_intent' not in ('BUY','RENT','SELL','INVEST','OTHER')) then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'budget_period' and (jsonb_typeof(p->'budget_period') is distinct from 'string' or p->>'budget_period' not in ('MONTH','YEAR','TOTAL','UNKNOWN')) then raise exception 'VALIDATION_FAILED';end if;
 foreach k in array array['property_type','purchase_timeline','source_reference','notes'] loop
  if p ? k and p->k<>'null'::jsonb and (jsonb_typeof(p->k)<>'string' or char_length(p->>k)>case k when 'property_type' then 120 when 'notes' then 2000 else 500 end) then raise exception 'VALIDATION_FAILED';end if;
 end loop;
 if p ? 'notes' and p->'notes'='null'::jsonb then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'bedrooms' and p->'bedrooms'<>'null'::jsonb and (jsonb_typeof(p->'bedrooms')<>'number' or p->>'bedrooms' !~ '^[0-9]+$' or (p->>'bedrooms')::numeric not between 0 and 50) then raise exception 'VALIDATION_FAILED';end if;
 if p ? 'locations' then
  if jsonb_typeof(p->'locations') is distinct from 'array' or jsonb_array_length(p->'locations')>5 then raise exception 'VALIDATION_FAILED';end if;
  for v in select value from jsonb_array_elements(p->'locations') loop
   if jsonb_typeof(v)<>'string' or char_length(trim(v#>>'{}')) not between 1 and 120 then raise exception 'VALIDATION_FAILED';end if;
  end loop;
 end if;
end;$$;
create function private.validate_lead(p_payload jsonb) returns void language plpgsql set search_path='' as $$
begin
 perform private.validate_lead_core(p_payload-array['confirmed_intent','budget_period','locations','property_type','bedrooms','purchase_timeline','source_reference','notes']);
 perform private.validate_facts(p_payload);
end;$$;
create function private.manager_writer(p_tenant uuid) returns public.memberships language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);begin if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;return m;end;$$;
create function private.insert_capture(p_tenant uuid,p_payload jsonb,p_assignee uuid,p_source text,p_actor uuid,p_request uuid,p_occurred timestamptz default null) returns public.leads
language plpgsql security definer set search_path='' as $$
declare l public.leads;dupe boolean;human boolean:=p_source<>'WEBSITE';
begin
 perform private.validate_lead(p_payload);
 if p_source not in ('MANUAL','CSV','WEBSITE') or p_actor is null or p_request is null or p_occurred>now() or (p_occurred is not null and not isfinite(p_occurred)) then raise exception 'VALIDATION_FAILED';end if;
 if p_assignee is not null and not exists(select 1 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and m.id=p_assignee and m.active and u.email_confirmed_at is not null) then raise exception 'VALIDATION_FAILED';end if;
 select exists(select 1 from public.leads x where x.tenant_id=p_tenant and ((coalesce(p_payload->>'email','')<>'' and lower(trim(x.email))=lower(trim(p_payload->>'email'))) or (coalesce(p_payload->>'phone','')<>'' and x.phone=p_payload->>'phone'))) into dupe;
 insert into public.leads(tenant_id,assignee_id,full_name,email,phone,source,created_by,budget_min,budget_max,currency,duplicate_review,confirmed_intent,budget_period,locations,property_type,bedrooms,purchase_timeline,source_reference,notes,reported_facts)
 values(p_tenant,p_assignee,trim(p_payload->>'full_name'),nullif(lower(trim(p_payload->>'email')),''),nullif(p_payload->>'phone',''),p_source,p_actor,
 case when human then (p_payload->>'budget_min')::numeric end,case when human then (p_payload->>'budget_max')::numeric end,case when human then p_payload->>'currency' end,dupe,
 case when human then p_payload->>'confirmed_intent' end,case when human then coalesce(p_payload->>'budget_period','UNKNOWN') else 'UNKNOWN' end,
 case when human then array(select distinct trim(value) from jsonb_array_elements_text(coalesce(p_payload->'locations','[]')) as v(value)) else '{}'::text[] end,
 case when human then nullif(trim(p_payload->>'property_type'),'') end,case when human then (p_payload->>'bedrooms')::integer end,case when human then nullif(trim(p_payload->>'purchase_timeline'),'') end,
 nullif(trim(p_payload->>'source_reference'),''),case when human then coalesce(p_payload->>'notes','') else '' end,
 case when human then '{}'::jsonb else p_payload-array['full_name','email','phone','initial_message','source_reference','notes','assignee_id'] end) returning * into l;
 if coalesce(trim(p_payload->>'initial_message'),'')<>'' then
  insert into public.messages(tenant_id,lead_id,direction,channel,body,occurred_at,author_id,source_reference,ingested_at)
  values(p_tenant,l.id,'INBOUND',case when p_source='WEBSITE' then 'WEBSITE' else 'MANUAL' end,trim(p_payload->>'initial_message'),coalesce(p_occurred,now()),p_actor,case when p_source='WEBSITE' then l.source_reference end,case when p_source='WEBSITE' then now() end);
 end if;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,l.id,p_actor,'LEAD_CREATED',p_request,jsonb_build_object('source',p_source));
 return l;
end;$$;
create or replace function public.create_lead(p_tenant uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);target uuid;l public.leads;r private.api_requests;op text:='lead:'||p_tenant;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 perform private.validate_lead(p_payload);if p_key is null or p_request_id is null then raise exception 'VALIDATION_FAILED';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;
 if found then
  if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;
  if not exists(select 1 from public.leads x where x.tenant_id=p_tenant and x.id=(r.response->>'id')::uuid and (m.role<>'AGENT' or x.assignee_id=m.id)) then raise exception 'NOT_FOUND';end if;return r.response;
 end if;
 if m.role='AGENT' then target:=m.id;if p_payload->>'assignee_id' is not null and p_payload->>'assignee_id'<>m.id::text then raise exception 'VALIDATION_FAILED';end if;
 else begin target:=(p_payload->>'assignee_id')::uuid;exception when invalid_text_representation then raise exception 'VALIDATION_FAILED';end;end if;
 l:=private.insert_capture(p_tenant,p_payload,target,'MANUAL',m.user_id,p_request_id);
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,to_jsonb(l),now());return to_jsonb(l);
end;$$;
create function public.update_lead_facts(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;r private.api_requests;op text:='facts:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','confirmed_intent','budget_period','locations','property_type','bedrooms','purchase_timeline','source_reference','notes')) or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or not exists(select 1 from jsonb_object_keys(p_payload-'expected_version')) then raise exception 'VALIDATION_FAILED';end if;
 perform private.validate_facts(p_payload);
 select * into l from public.leads x where x.tenant_id=p_tenant and x.id=p_lead and (m.role<>'AGENT' or x.assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if p_payload->>'expected_version'<>l.version::text then raise exception 'VERSION_CONFLICT';end if;if l.archived_at is not null then raise exception 'CONTACT_BLOCKED';end if;
 if l.source='WEBSITE' and p_payload ? 'source_reference' and (p_payload->>'source_reference') is distinct from l.source_reference then raise exception 'PROVENANCE_IMMUTABLE';end if;
 update public.leads set confirmed_intent=case when p_payload ? 'confirmed_intent' then p_payload->>'confirmed_intent' else confirmed_intent end,
 budget_period=coalesce(p_payload->>'budget_period',budget_period),locations=case when p_payload ? 'locations' then array(select distinct trim(value) from jsonb_array_elements_text(p_payload->'locations') v(value)) else locations end,
 property_type=case when p_payload ? 'property_type' then nullif(trim(p_payload->>'property_type'),'') else property_type end,
 bedrooms=case when p_payload ? 'bedrooms' then (p_payload->>'bedrooms')::integer else bedrooms end,purchase_timeline=case when p_payload ? 'purchase_timeline' then nullif(trim(p_payload->>'purchase_timeline'),'') else purchase_timeline end,
 source_reference=case when p_payload ? 'source_reference' then nullif(trim(p_payload->>'source_reference'),'') else source_reference end,notes=coalesce(p_payload->>'notes',notes),version=version+1,context_version=context_version+1 where tenant_id=p_tenant and id=p_lead returning * into l;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,details) values(p_tenant,p_lead,m.user_id,'FACTS_CONFIRMED',p_request_id,jsonb_build_object('fields',array(select jsonb_object_keys(p_payload-'expected_version'))));
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,to_jsonb(l),now());return to_jsonb(l);
end;$$;
create function public.duplicate_candidates(p_tenant uuid,p_lead uuid,p_limit integer default 25,p_after uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);l public.leads;rows jsonb;
begin
 select * into l from public.leads x where x.tenant_id=p_tenant and x.id=p_lead and (m.role<>'AGENT' or x.assignee_id=m.id);if not found then raise exception 'NOT_FOUND';end if;
 if m.role='AGENT' then return jsonb_build_object('review_required',l.duplicate_review,'candidates','[]'::jsonb,'restricted',true);end if;
 select coalesce(jsonb_agg(to_jsonb(c)),'[]') into rows from (select x.id,x.full_name,x.email,x.phone,x.status,x.archived_at from public.leads x where x.tenant_id=p_tenant and x.id<>p_lead and (p_after is null or x.id>p_after) and ((l.email is not null and lower(trim(x.email))=lower(trim(l.email))) or (l.phone is not null and x.phone=l.phone)) order by x.id limit least(greatest(p_limit,1),101)) c;
 return jsonb_build_object('review_required',l.duplicate_review,'candidates',rows,'restricted',false);
end;$$;
create function public.resolve_duplicate(p_tenant uuid,p_lead uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);l public.leads;r private.api_requests;op text:='duplicate:'||p_tenant||':'||p_lead;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('expected_version','reason')) or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if p_payload->>'expected_version'<>l.version::text then raise exception 'VERSION_CONFLICT';end if;if not l.duplicate_review then raise exception 'STATE_CONFLICT';end if;
 update public.leads set duplicate_review=false,version=version+1 where tenant_id=p_tenant and id=p_lead returning * into l;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,p_lead,m.user_id,'DUPLICATE_RESOLVED_SEPARATE',p_request_id,trim(p_payload->>'reason'),'{}');
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,to_jsonb(l),now());return to_jsonb(l);
end;$$;
create function public.revise_message(p_tenant uuid,p_lead uuid,p_message uuid,p_payload jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.writer_member(p_tenant);l public.leads;msg public.messages;r private.api_requests;op text:='revision:'||p_tenant||':'||p_message;h text:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');result jsonb;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_payload) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_payload) k where k not in ('body','reason','expected_version','expected_lead_version')) or jsonb_typeof(p_payload->'expected_version') is distinct from 'number' or jsonb_typeof(p_payload->'expected_lead_version') is distinct from 'number' or jsonb_typeof(p_payload->'body') is distinct from 'string' or char_length(trim(p_payload->>'body')) not between 1 and 10000 or jsonb_typeof(p_payload->'reason') is distinct from 'string' or char_length(trim(p_payload->>'reason')) not between 5 and 500 then raise exception 'VALIDATION_FAILED';end if;
 select * into l from public.leads where tenant_id=p_tenant and id=p_lead and (m.role<>'AGENT' or assignee_id=m.id) for update;if not found then raise exception 'NOT_FOUND';end if;
 select * into msg from public.messages where tenant_id=p_tenant and lead_id=p_lead and id=p_message for update;if not found then raise exception 'NOT_FOUND';end if;
 if msg.channel<>'MANUAL' then raise exception 'PROVENANCE_IMMUTABLE';end if;
 select * into r from private.api_requests where actor_id=m.user_id and operation=op and request_key=p_key;if found then if r.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return r.response;end if;
 if p_payload->>'expected_version'<>msg.version::text or p_payload->>'expected_lead_version'<>l.version::text then raise exception 'VERSION_CONFLICT';end if;
 if l.archived_at is not null then raise exception 'CONTACT_BLOCKED';end if;
 insert into public.message_revisions(tenant_id,lead_id,message_id,previous_body,revision,reason,actor_id) values(p_tenant,p_lead,p_message,msg.body,msg.version,trim(p_payload->>'reason'),m.user_id);
 update public.messages set body=trim(p_payload->>'body'),version=version+1 where tenant_id=p_tenant and id=p_message returning * into msg;
 update public.leads set version=version+1,context_version=context_version+case when msg.direction='INBOUND' then 1 else 0 end where tenant_id=p_tenant and id=p_lead returning * into l;
 insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,p_lead,m.user_id,'MESSAGE_REVISED',p_request_id,trim(p_payload->>'reason'),jsonb_build_object('message_id',p_message,'version',msg.version));
 result:=jsonb_build_object('message',to_jsonb(msg),'lead_version',l.version,'context_version',l.context_version);
 insert into private.api_requests values(m.user_id,op,p_key,h,p_tenant,result,now());return result;
end;$$;
revoke all on function private.validate_lead_core(jsonb),private.validate_lead(jsonb),private.validate_facts(jsonb),private.manager_writer(uuid),private.insert_capture(uuid,jsonb,uuid,text,uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.update_lead_facts(uuid,uuid,jsonb,uuid,uuid),public.duplicate_candidates(uuid,uuid,integer,uuid),public.resolve_duplicate(uuid,uuid,jsonb,uuid,uuid),public.revise_message(uuid,uuid,uuid,jsonb,uuid,uuid) from public,anon;
grant execute on function public.update_lead_facts(uuid,uuid,jsonb,uuid,uuid),public.duplicate_candidates(uuid,uuid,integer,uuid),public.resolve_duplicate(uuid,uuid,jsonb,uuid,uuid),public.revise_message(uuid,uuid,uuid,jsonb,uuid,uuid) to authenticated;
commit;
