begin;

-- Supabase auth.users.email is varchar(255); this RPC promises text.
-- RETURN QUERY requires matching types even though ordinary assignments coerce.
-- Preserve the read membership boundary, signature and existing function grants.
create or replace function public.list_team_members(p_tenant uuid,p_limit integer default 25,p_cursor_time timestamptz default null,p_cursor_id uuid default null) returns table(id uuid,role public.member_role,active boolean,display_name text,email text,version integer,created_at timestamptz,lead_count bigint,open_task_count bigint)
language plpgsql security definer set search_path='' as $$
declare member public.memberships:=private.read_member(p_tenant);
begin
 return query select m.id,m.role,m.active,m.display_name,u.email::text,m.version,m.created_at,
 (select count(*) from public.leads l where l.tenant_id=p_tenant and l.assignee_id=m.id),
 (select count(*) from public.follow_ups f where f.tenant_id=p_tenant and f.assignee_id=m.id and f.state='OPEN')
 from public.memberships m join auth.users u on u.id=m.user_id where m.tenant_id=p_tenant and (member.role in ('OWNER','ADMIN') or m.id=member.id)
 and (p_cursor_time is null or (m.created_at,m.id)>(p_cursor_time,p_cursor_id)) order by m.created_at,m.id limit least(greatest(p_limit,1),101);
end; $$;

notify pgrst,'reload schema';
commit;
