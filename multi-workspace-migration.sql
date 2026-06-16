-- Avantex Work Tracker multi-workspace upgrade
-- Run once in Supabase SQL Editor after the previous schema.

create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'editor')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table if not exists public.workspace_invites (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'editor')),
  token text not null unique,
  invited_by uuid references auth.users(id) on delete set null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now()
);

alter table public.editors add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;
alter table public.attendance_logs add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;
alter table public.daily_work add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade;

alter table public.editors drop constraint if exists editors_user_id_key;
alter table public.daily_work drop constraint if exists daily_work_editor_id_work_date_key;
alter table public.daily_work drop constraint if exists daily_work_workspace_editor_date_unique;

insert into public.workspaces (name, created_by)
select 'Avantex Work Tracker', (select user_id from public.profiles where role = 'admin' limit 1)
where not exists (select 1 from public.workspaces where name = 'Avantex Work Tracker');

update public.editors
set workspace_id = (select id from public.workspaces where name = 'Avantex Work Tracker' order by created_at limit 1)
where workspace_id is null;

update public.attendance_logs a
set workspace_id = e.workspace_id
from public.editors e
where a.editor_id = e.id and a.workspace_id is null;

update public.daily_work d
set workspace_id = e.workspace_id
from public.editors e
where d.editor_id = e.id and d.workspace_id is null;

insert into public.memberships (workspace_id, user_id, role)
select w.id, p.user_id, 'owner'
from public.workspaces w
join public.profiles p on p.role = 'admin'
where w.name = 'Avantex Work Tracker'
on conflict (workspace_id, user_id) do update set role = excluded.role, active = true;

insert into public.memberships (workspace_id, user_id, role)
select e.workspace_id, e.user_id, 'editor'
from public.editors e
where e.user_id is not null
on conflict (workspace_id, user_id) do nothing;

alter table public.editors alter column workspace_id set not null;
alter table public.attendance_logs alter column workspace_id set not null;
alter table public.daily_work alter column workspace_id set not null;

create unique index if not exists editors_workspace_user_unique
on public.editors (workspace_id, user_id)
where user_id is not null;

alter table public.daily_work
add constraint daily_work_workspace_editor_date_unique unique (workspace_id, editor_id, work_date);

create or replace function public.is_workspace_member(target_workspace uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.active = true
  );
$$;

create or replace function public.has_workspace_role(target_workspace uuid, allowed_roles text[])
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = target_workspace
      and m.user_id = auth.uid()
      and m.active = true
      and m.role = any(allowed_roles)
  );
$$;

create or replace function public.create_workspace_with_owner(workspace_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_workspace_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  insert into public.workspaces (name, created_by)
  values (nullif(trim(workspace_name), ''), auth.uid())
  returning id into new_workspace_id;

  insert into public.memberships (workspace_id, user_id, role)
  values (new_workspace_id, auth.uid(), 'owner');

  return new_workspace_id;
end;
$$;

create or replace function public.accept_workspace_invite(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_row public.workspace_invites%rowtype;
  profile_name text;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  select *
  into invite_row
  from public.workspace_invites
  where token = invite_token
    and accepted_at is null
    and expires_at > now()
  limit 1;

  if invite_row.id is null then
    raise exception 'Invite is invalid or expired';
  end if;

  if lower(invite_row.email) <> lower(coalesce(auth.jwt()->>'email', '')) then
    raise exception 'Login with the invited email address';
  end if;

  insert into public.memberships (workspace_id, user_id, role)
  values (invite_row.workspace_id, auth.uid(), invite_row.role)
  on conflict (workspace_id, user_id) do update set role = excluded.role, active = true;

  if invite_row.role = 'editor' then
    select coalesce(display_name, split_part(email, '@', 1))
    into profile_name
    from public.profiles
    where user_id = auth.uid();

    insert into public.editors (workspace_id, user_id, name, role, active)
    values (invite_row.workspace_id, auth.uid(), coalesce(profile_name, split_part(invite_row.email, '@', 1)), 'Team Member', true)
    on conflict do nothing;
  end if;

  update public.workspace_invites
  set accepted_by = auth.uid(), accepted_at = now()
  where id = invite_row.id;

  return invite_row.workspace_id;
end;
$$;

alter table public.workspaces enable row level security;
alter table public.memberships enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.profiles enable row level security;
alter table public.editors enable row level security;
alter table public.attendance_logs enable row level security;
alter table public.daily_work enable row level security;

drop policy if exists "workspaces select members" on public.workspaces;
create policy "workspaces select members"
on public.workspaces for select
to authenticated
using (public.is_workspace_member(id));

drop policy if exists "memberships select own or admin" on public.memberships;
create policy "memberships select own or admin"
on public.memberships for select
to authenticated
using (user_id = auth.uid() or public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "memberships admin update" on public.memberships;
create policy "memberships admin update"
on public.memberships for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "invites select admin" on public.workspace_invites;
create policy "invites select admin"
on public.workspace_invites for select
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "invites insert admin" on public.workspace_invites;
create policy "invites insert admin"
on public.workspace_invites for insert
to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']) and invited_by = auth.uid());

drop policy if exists "profiles select own or admin" on public.profiles;
create policy "profiles select own or admin"
on public.profiles for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "profiles update admin" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
on public.profiles for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "editors select own or admin" on public.editors;
drop policy if exists "editors workspace select" on public.editors;
create policy "editors workspace select"
on public.editors for select
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']) or user_id = auth.uid());

drop policy if exists "editors admin insert" on public.editors;
drop policy if exists "editors workspace admin insert" on public.editors;
create policy "editors workspace admin insert"
on public.editors for insert
to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "editors admin update" on public.editors;
drop policy if exists "editors workspace admin update" on public.editors;
create policy "editors workspace admin update"
on public.editors for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "editors admin delete" on public.editors;
drop policy if exists "editors workspace admin delete" on public.editors;
create policy "editors workspace admin delete"
on public.editors for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "attendance select own or admin" on public.attendance_logs;
drop policy if exists "attendance workspace select" on public.attendance_logs;
create policy "attendance workspace select"
on public.attendance_logs for select
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = attendance_logs.editor_id
      and e.workspace_id = attendance_logs.workspace_id
      and e.user_id = auth.uid()
  )
);

drop policy if exists "attendance insert own or admin" on public.attendance_logs;
drop policy if exists "attendance workspace insert" on public.attendance_logs;
create policy "attendance workspace insert"
on public.attendance_logs for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    or exists (
      select 1 from public.editors e
      where e.id = attendance_logs.editor_id
        and e.workspace_id = attendance_logs.workspace_id
        and e.user_id = auth.uid()
    )
  )
);

drop policy if exists "attendance admin update" on public.attendance_logs;
drop policy if exists "attendance workspace admin update" on public.attendance_logs;
create policy "attendance workspace admin update"
on public.attendance_logs for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "attendance admin delete" on public.attendance_logs;
drop policy if exists "attendance workspace admin delete" on public.attendance_logs;
create policy "attendance workspace admin delete"
on public.attendance_logs for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "daily work select own or admin" on public.daily_work;
drop policy if exists "daily work workspace select" on public.daily_work;
create policy "daily work workspace select"
on public.daily_work for select
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id
      and e.workspace_id = daily_work.workspace_id
      and e.user_id = auth.uid()
  )
);

drop policy if exists "daily work insert own or admin" on public.daily_work;
drop policy if exists "daily work workspace insert" on public.daily_work;
create policy "daily work workspace insert"
on public.daily_work for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.has_workspace_role(workspace_id, array['owner', 'admin'])
    or exists (
      select 1 from public.editors e
      where e.id = daily_work.editor_id
        and e.workspace_id = daily_work.workspace_id
        and e.user_id = auth.uid()
    )
  )
);

drop policy if exists "daily work update own or admin" on public.daily_work;
drop policy if exists "daily work workspace update" on public.daily_work;
create policy "daily work workspace update"
on public.daily_work for update
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id
      and e.workspace_id = daily_work.workspace_id
      and e.user_id = auth.uid()
  )
)
with check (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id
      and e.workspace_id = daily_work.workspace_id
      and e.user_id = auth.uid()
  )
);

drop policy if exists "daily work admin delete" on public.daily_work;
drop policy if exists "daily work workspace admin delete" on public.daily_work;
create policy "daily work workspace admin delete"
on public.daily_work for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));
