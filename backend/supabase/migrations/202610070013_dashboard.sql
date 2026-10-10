begin;
-- Every metric and its pages use these identical, explicitly authorized rows.
create function private.dashboard_window(p_tenant uuid,p_from date,p_to date,p_as_of timestamptz)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);tz text;f date;t date;
begin
 select timezone into tz from public.agencies where id=p_tenant;
 if (p_from is null)<>(p_to is null) or p_as_of is null or p_as_of>clock_timestamp()+interval '5 seconds' or p_as_of<clock_timestamp()-interval '24 hours' then raise exception 'VALIDATION_FAILED';end if;
 t:=coalesce(p_to,(p_as_of at time zone tz)::date);f:=coalesce(p_from,t-29);
 if f>t or t-f>365 or f<date '1970-01-01' or t>date '9998-12-31' then raise exception 'VALIDATION_FAILED';end if;
 return jsonb_build_object('from',f,'to',t,'timezone',tz,'start_at',f::timestamp at time zone tz,'end_at',(t+1)::timestamp at time zone tz,'as_of',p_as_of,'scope',case when m.role='AGENT' then 'CURRENT_ASSIGNED' else 'AGENCY' end,'manager',m.role in ('OWNER','ADMIN'));
end;$$;
create function private.dashboard_items(p_tenant uuid,p_metric text,p_start timestamptz,p_end timestamptz,p_as_of timestamptz)
returns table(row_id uuid,sort_at timestamptz,entity text,payload jsonb) language plpgsql stable security definer set search_path='' as $$
declare m public.memberships:=private.active_member(p_tenant);
begin
 if p_metric not in ('TOTAL','QUALIFIED','WON','UNASSIGNED','DUE','CONTACTED_IN_COHORT','STAGE_NEW','STAGE_CONTACTED','STAGE_QUALIFIED','STAGE_FOLLOW_UP','STAGE_WON','STAGE_LOST') or p_metric is null then raise exception 'VALIDATION_FAILED';end if;
 if p_metric='UNASSIGNED' and m.role='AGENT' then raise exception 'ROLE_REQUIRED';end if;
 if p_metric='DUE' then
  return query select f.id,f.due_at,'TASK'::text,to_jsonb(f)||jsonb_build_object('lead_name',l.full_name,'lead_status',l.status)
  from public.follow_ups f join public.leads l on l.tenant_id=f.tenant_id and l.id=f.lead_id
  where l.tenant_id=p_tenant and l.archived_at is null and f.state='OPEN' and f.due_at<=p_as_of
  and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id and f.assignee_id=m.id);
 else
  return query select l.id,l.created_at,'LEAD'::text,to_jsonb(l)||case when p_metric='CONTACTED_IN_COHORT' then jsonb_build_object('first_logged_contact_at',contact.first_at,'contact_latency_seconds',extract(epoch from contact.first_at-l.created_at)) else '{}'::jsonb end
  from public.leads l left join lateral(select min(msg.occurred_at) first_at from public.messages msg where msg.tenant_id=l.tenant_id and msg.lead_id=l.id and msg.direction='OUTBOUND' and msg.delivery_status='USER_REPORTED' and msg.occurred_at>=l.created_at and msg.occurred_at<=p_as_of) contact on p_metric='CONTACTED_IN_COHORT'
  where l.tenant_id=p_tenant and l.archived_at is null and (m.role in ('OWNER','ADMIN') or l.assignee_id=m.id)
  and case
   when p_metric='WON' then l.status='WON' and l.won_at>=p_start and l.won_at<p_end
   when p_metric='UNASSIGNED' then l.assignee_id is null and l.status not in ('WON','LOST')
   else l.created_at>=p_start and l.created_at<p_end and case when p_metric='QUALIFIED' then l.status='QUALIFIED' when p_metric='CONTACTED_IN_COHORT' then contact.first_at is not null when p_metric like 'STAGE_%' then l.status::text=substr(p_metric,7) else true end
  end;
 end if;
end;$$;
create function public.dashboard_summary(p_tenant uuid,p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare w jsonb:=private.dashboard_window(p_tenant,p_from,p_to,statement_timestamp());s timestamptz:=(w->>'start_at')::timestamptz;e timestamptz:=(w->>'end_at')::timestamptz;a timestamptz:=(w->>'as_of')::timestamptz;cohort jsonb;pipeline jsonb;total bigint;qualified bigint;won bigint;due bigint;unassigned bigint;contacted bigint;median_seconds numeric;
begin
 select count(*),count(*) filter(where payload->>'status'='QUALIFIED'),coalesce(jsonb_agg(jsonb_build_object('status',payload->'status')),'[]') into total,qualified,cohort from private.dashboard_items(p_tenant,'TOTAL',s,e,a);
 select jsonb_object_agg(stage,cnt) into pipeline from (select status::text stage,(select count(*) from jsonb_array_elements(cohort) c where c->>'status'=status::text) cnt from unnest(enum_range(null::public.lead_status)) status) stages;
 select count(*) into won from private.dashboard_items(p_tenant,'WON',s,e,a);select count(*) into due from private.dashboard_items(p_tenant,'DUE',s,e,a);
 if (w->>'manager')::boolean then select count(*) into unassigned from private.dashboard_items(p_tenant,'UNASSIGNED',s,e,a);end if;
 select count(*),percentile_cont(0.5) within group(order by (payload->>'contact_latency_seconds')::numeric) into contacted,median_seconds from private.dashboard_items(p_tenant,'CONTACTED_IN_COHORT',s,e,a);
 return jsonb_build_object('window',w,'metrics',jsonb_build_object('total',total,'qualified',qualified,'won',won,'due',due,'unassigned',unassigned),'pipeline',pipeline,'contact',jsonb_build_object('sample_count',contacted,'without_logged_contact',total-contacted,'median_seconds',median_seconds));
end;$$;
create function public.dashboard_drilldown(p_tenant uuid,p_metric text,p_from date,p_to date,p_as_of timestamptz,p_limit integer default 26,p_cursor_time timestamptz default null,p_cursor_id uuid default null)
returns table(row_id uuid,sort_at timestamptz,entity text,payload jsonb) language plpgsql stable security definer set search_path='' as $$
declare w jsonb:=private.dashboard_window(p_tenant,p_from,p_to,p_as_of);
begin
 if p_limit is null or p_limit not between 1 and 101 or (p_cursor_time is null)<>(p_cursor_id is null) then raise exception 'VALIDATION_FAILED';end if;
 return query select i.* from private.dashboard_items(p_tenant,p_metric,(w->>'start_at')::timestamptz,(w->>'end_at')::timestamptz,p_as_of) i
 where p_cursor_time is null or (i.sort_at,i.row_id)<(p_cursor_time,p_cursor_id) order by i.sort_at desc,i.row_id desc limit p_limit;
end;$$;
revoke all on function private.dashboard_window(uuid,date,date,timestamptz),private.dashboard_items(uuid,text,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.dashboard_summary(uuid,date,date),public.dashboard_drilldown(uuid,text,date,date,timestamptz,integer,timestamptz,uuid) from public,anon;
grant execute on function public.dashboard_summary(uuid,date,date),public.dashboard_drilldown(uuid,text,date,date,timestamptz,integer,timestamptz,uuid) to authenticated;
create index dashboard_won on public.leads(tenant_id,won_at,id) where archived_at is null and status='WON';
create index dashboard_first_contact on public.messages(tenant_id,lead_id,occurred_at) where direction='OUTBOUND' and delivery_status='USER_REPORTED';
commit;
