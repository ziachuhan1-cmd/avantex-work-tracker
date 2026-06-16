-- Avantex Work Tracker member link diagnostic and fix
-- Use when admin cannot see a member's attendance/work after invite acceptance.

-- 1) Make sure every accepted editor invite has an active membership.
insert into public.memberships (workspace_id, user_id, role, active)
select wi.workspace_id, wi.accepted_by, wi.role, true
from public.workspace_invites wi
where wi.accepted_by is not null
  and wi.role = 'editor'
on conflict (workspace_id, user_id)
do update set role = excluded.role, active = true;

-- 2) Make sure every accepted editor invite has an active editor row linked to that user.
insert into public.editors (workspace_id, user_id, name, role, active)
select
  wi.workspace_id,
  wi.accepted_by,
  coalesce(p.display_name, split_part(wi.email, '@', 1)),
  'Team Member',
  true
from public.workspace_invites wi
left join public.profiles p on p.user_id = wi.accepted_by
where wi.accepted_by is not null
  and wi.role = 'editor'
on conflict (workspace_id, user_id)
do update set
  active = true,
  name = coalesce(excluded.name, public.editors.name),
  role = coalesce(public.editors.role, excluded.role);

-- 3) If an accepted invite email already has a manual editor row without user_id,
-- link that row to the accepted user when the name/email prefix matches.
update public.editors e
set user_id = wi.accepted_by,
    active = true
from public.workspace_invites wi
where e.workspace_id = wi.workspace_id
  and e.user_id is null
  and wi.accepted_by is not null
  and wi.role = 'editor'
  and lower(regexp_replace(e.name, '\s+', '', 'g')) = lower(regexp_replace(split_part(wi.email, '@', 1), '\s+', '', 'g'));

-- 4) Diagnostic output.
select
  w.name as workspace,
  coalesce(p.email, wi.email) as member_email,
  m.role as membership_role,
  m.active as membership_active,
  e.id as editor_id,
  e.name as editor_name,
  e.active as editor_active,
  count(distinct a.id) as attendance_rows,
  count(distinct d.id) as work_rows
from public.workspace_invites wi
join public.workspaces w on w.id = wi.workspace_id
left join public.profiles p on p.user_id = wi.accepted_by
left join public.memberships m on m.workspace_id = wi.workspace_id and m.user_id = wi.accepted_by
left join public.editors e on e.workspace_id = wi.workspace_id and e.user_id = wi.accepted_by
left join public.attendance_logs a on a.workspace_id = wi.workspace_id and a.editor_id = e.id
left join public.daily_work d on d.workspace_id = wi.workspace_id and d.editor_id = e.id
where wi.accepted_by is not null
group by w.name, coalesce(p.email, wi.email), m.role, m.active, e.id, e.name, e.active
order by w.name, member_email;
