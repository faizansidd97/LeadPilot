begin;
create table private.lead_imports(id uuid primary key default gen_random_uuid(),tenant_id uuid not null references public.agencies(id),actor_id uuid not null references auth.users(id),request_key uuid not null,
 payload_hash text not null,total integer not null check(total between 1 and 1000),state text not null default 'PREVIEW' check(state in ('PREVIEW','RUNNING','COMPLETE')),
 create_separate boolean not null default false,reason text,created_at timestamptz not null default now(),unique(tenant_id,actor_id,request_key),unique(tenant_id,id));
create table private.lead_import_rows(tenant_id uuid not null,import_id uuid not null,row_index integer not null check(row_index between 1 and 1000),payload jsonb,
 state text not null default 'PENDING' check(state in ('PENDING','CREATED','DUPLICATE','INVALID','FAILED')),errors jsonb not null default '{}',attempts integer not null default 0 check(attempts between 0 and 3),lead_id uuid,
 primary key(import_id,row_index),foreign key(tenant_id,import_id) references private.lead_imports(tenant_id,id),foreign key(tenant_id,lead_id) references public.leads(tenant_id,id));
revoke all on private.lead_imports,private.lead_import_rows from public,anon,authenticated;
create index import_recent on private.lead_imports(tenant_id,created_at desc,id);
create function private.import_result(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',i.id,'state',i.state,'total',i.total,'created_at',i.created_at,'create_separate',i.create_separate,'reason',i.reason,
 'created',count(*) filter(where r.state='CREATED'),'duplicate',count(*) filter(where r.state='DUPLICATE'),'invalid',count(*) filter(where r.state='INVALID'),
 'failed',count(*) filter(where r.state='FAILED'),'pending',count(*) filter(where r.state='PENDING'),'retryable',count(*) filter(where r.state='FAILED' and r.attempts<3))
 from private.lead_imports i join private.lead_import_rows r on r.import_id=i.id where i.id=p_id group by i.id;
$$;
create function public.prepare_lead_import(p_tenant uuid,p_rows jsonb,p_key uuid,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);i private.lead_imports;r jsonb;p jsonb;err jsonb;h text:=encode(sha256(convert_to(p_rows::text,'UTF8')),'hex');n integer:=0;target uuid;
begin
 if p_key is null or p_request_id is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 1000 or octet_length(p_rows::text)>10*1024*1024 then raise exception 'VALIDATION_FAILED';end if;
 select * into i from private.lead_imports where tenant_id=p_tenant and actor_id=m.user_id and request_key=p_key;if found then if i.payload_hash<>h then raise exception 'IDEMPOTENCY_CONFLICT';end if;return private.import_result(i.id);end if;
 insert into private.lead_imports(tenant_id,actor_id,request_key,payload_hash,total) values(p_tenant,m.user_id,p_key,h,jsonb_array_length(p_rows)) returning * into i;
 for r in select value from jsonb_array_elements(p_rows) loop
  n:=n+1;err:='{}';p:=r->'payload';
  if jsonb_typeof(r) is distinct from 'object' or (r->>'row_index') is distinct from n::text or exists(select 1 from jsonb_object_keys(r) k where k not in ('row_index','payload','errors')) then raise exception 'VALIDATION_FAILED';end if;
  if r ? 'errors' then
   if jsonb_typeof(r->'errors') is distinct from 'object' or char_length((r->'errors')::text)>4000 or not exists(select 1 from jsonb_object_keys(r->'errors')) or r ? 'payload' then raise exception 'VALIDATION_FAILED';end if;
   -- Store safe errors only, never malformed raw input.
   err:=r->'errors';p:=null;
  else
   begin
    perform private.validate_lead(p-'assignee_email');
    if p ? 'assignee_id' or (p ? 'assignee_email' and jsonb_typeof(p->'assignee_email') is distinct from 'string') then raise exception 'VALIDATION_FAILED';end if;
    if coalesce(p->>'assignee_email','')<>'' then
     select x.id into target from public.memberships x join auth.users u on u.id=x.user_id where x.tenant_id=p_tenant and x.active and u.email_confirmed_at is not null and lower(trim(u.email))=lower(trim(p->>'assignee_email'));
     if not found then err:=jsonb_build_object('assignee_email','No active teammate matches this email.');end if;
    end if;
   exception when others then err:=jsonb_build_object('_row','Check the supplied fields.');end;
   if err<>'{}'::jsonb then p:=null;end if;
  end if;
  insert into private.lead_import_rows(tenant_id,import_id,row_index,payload,state,errors) values(p_tenant,i.id,n,p,case when err='{}'::jsonb then 'PENDING' else 'INVALID' end,err);
 end loop;
 insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,m.user_id,'IMPORT_PREPARED',p_request_id,jsonb_build_object('import_id',i.id,'total',i.total));
 return private.import_result(i.id);
end;$$;
create function public.list_lead_imports(p_tenant uuid,p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 25) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);result jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select coalesce(jsonb_agg(private.import_result(x.id)),'[]') into result from (select id from private.lead_imports where tenant_id=p_tenant and (p_before is null or (created_at,id)<(p_before,p_before_id)) order by created_at desc,id desc limit least(greatest(p_limit,1),101)) x;return result;
end;$$;
create function public.lead_import_detail(p_tenant uuid,p_import uuid,p_after integer default 0,p_limit integer default 20) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);i private.lead_imports;rows jsonb;begin
 if m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 select * into i from private.lead_imports where tenant_id=p_tenant and id=p_import;if not found then raise exception 'NOT_FOUND';end if;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into rows from (select r.row_index,r.state,r.errors,r.attempts,r.lead_id,
 case when i.state='PREVIEW' then r.payload else null end as preview,
 case when i.state='PREVIEW' and r.payload is not null then exists(select 1 from public.leads l where l.tenant_id=p_tenant and ((coalesce(r.payload->>'email','')<>'' and lower(trim(l.email))=lower(trim(r.payload->>'email'))) or (coalesce(r.payload->>'phone','')<>'' and l.phone=r.payload->>'phone'))) else false end as duplicate
 from private.lead_import_rows r where r.tenant_id=p_tenant and r.import_id=p_import and r.row_index>greatest(p_after,0) order by r.row_index limit least(greatest(p_limit,1),101)) x;
 return private.import_result(i.id)||jsonb_build_object('rows',rows);
end;$$;
create function public.process_lead_import(p_tenant uuid,p_import uuid,p_confirm jsonb,p_retry boolean,p_request_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.memberships:=private.manager_writer(p_tenant);i private.lead_imports;r private.lead_import_rows;target uuid;l public.leads;dupe boolean;v_reason text;separate boolean;processed integer:=0;
begin
 if p_request_id is null or p_retry is null or jsonb_typeof(p_confirm) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_confirm) k where k not in ('create_separate','reason')) or jsonb_typeof(p_confirm->'create_separate') is distinct from 'boolean' or jsonb_typeof(p_confirm->'reason') is distinct from 'string' or char_length(p_confirm->>'reason')>500 then raise exception 'VALIDATION_FAILED';end if;
 separate:=(p_confirm->>'create_separate')::boolean;v_reason:=trim(p_confirm->>'reason');if separate and char_length(v_reason)<5 then raise exception 'VALIDATION_FAILED';end if;
 select * into i from private.lead_imports where tenant_id=p_tenant and id=p_import for update;if not found then raise exception 'NOT_FOUND';end if;
 if i.state='PREVIEW' then
  update private.lead_imports set state='RUNNING',create_separate=separate,reason=v_reason where id=i.id returning * into i;
  insert into public.activity_events(tenant_id,actor_id,event_type,request_id,reason,details) values(p_tenant,m.user_id,'IMPORT_CONFIRMED',p_request_id,nullif(v_reason,''),jsonb_build_object('import_id',i.id,'create_separate',separate));
 elsif i.create_separate<>separate or i.reason<>v_reason then raise exception 'IDEMPOTENCY_CONFLICT';end if;
 if p_retry then update private.lead_import_rows set state='PENDING' where import_id=i.id and state='FAILED' and attempts<3;end if;
 for r in select * from private.lead_import_rows where import_id=i.id and state='PENDING' order by row_index limit 25 for update loop
  processed:=processed+1;
  begin
   target:=null;perform private.validate_lead(r.payload-'assignee_email');
   if coalesce(r.payload->>'assignee_email','')<>'' then
    select x.id into target from public.memberships x join auth.users u on u.id=x.user_id where x.tenant_id=p_tenant and x.active and u.email_confirmed_at is not null and lower(trim(u.email))=lower(trim(r.payload->>'assignee_email'));
    if not found then raise exception 'VALIDATION_FAILED';end if;
   end if;
   select exists(select 1 from public.leads x where x.tenant_id=p_tenant and ((coalesce(r.payload->>'email','')<>'' and lower(trim(x.email))=lower(trim(r.payload->>'email'))) or (coalesce(r.payload->>'phone','')<>'' and x.phone=r.payload->>'phone'))) into dupe;
   if dupe and not separate then update private.lead_import_rows set state='DUPLICATE',payload=null where import_id=i.id and row_index=r.row_index;
   else
    l:=private.insert_capture(p_tenant,r.payload-'assignee_email',target,'CSV',m.user_id,p_request_id);
    if dupe then insert into public.activity_events(tenant_id,lead_id,actor_id,event_type,request_id,reason,details) values(p_tenant,l.id,m.user_id,'DUPLICATE_IMPORT_OVERRIDE',p_request_id,v_reason,jsonb_build_object('import_id',i.id,'row_index',r.row_index));end if;
    update private.lead_import_rows set state='CREATED',lead_id=l.id,payload=null,errors='{}' where import_id=i.id and row_index=r.row_index;
   end if;
  exception when others then
   update private.lead_import_rows set state=case when sqlerrm='VALIDATION_FAILED' then 'INVALID' else 'FAILED' end,
   errors=jsonb_build_object('_row',case when sqlerrm='VALIDATION_FAILED' then 'Check fields and current active assignee.' else 'Temporary write failure. Retry this row.' end),attempts=attempts+1,
   payload=case when sqlerrm='VALIDATION_FAILED' or attempts+1>=3 then null else payload end where import_id=i.id and row_index=r.row_index;
  end;
 end loop;
 update private.lead_imports set state=case when exists(select 1 from private.lead_import_rows where import_id=i.id and state='PENDING') then 'RUNNING' else 'COMPLETE' end where id=i.id;
 if processed>0 then insert into public.activity_events(tenant_id,actor_id,event_type,request_id,details) values(p_tenant,m.user_id,'IMPORT_BATCH_PROCESSED',p_request_id,jsonb_build_object('import_id',i.id,'processed',processed,'retry',p_retry));end if;
 return private.import_result(i.id);
end;$$;
revoke all on function private.import_result(uuid) from public,anon,authenticated;
revoke all on function public.prepare_lead_import(uuid,jsonb,uuid,uuid),public.list_lead_imports(uuid,timestamptz,uuid,integer),public.lead_import_detail(uuid,uuid,integer,integer),public.process_lead_import(uuid,uuid,jsonb,boolean,uuid) from public,anon;
grant execute on function public.prepare_lead_import(uuid,jsonb,uuid,uuid),public.list_lead_imports(uuid,timestamptz,uuid,integer),public.lead_import_detail(uuid,uuid,integer,integer),public.process_lead_import(uuid,uuid,jsonb,boolean,uuid) to authenticated;
commit;
