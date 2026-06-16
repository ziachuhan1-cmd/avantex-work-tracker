-- Avantex Work Tracker Supabase setup
-- Run this in Supabase Dashboard > SQL Editor.
-- For ClickUp-style workspaces and invites, run multi-workspace-migration.sql after this file.
-- After this, create users in Authentication > Users.
-- Then set your own user as admin:
-- update public.profiles set role = 'admin', display_name = 'Admin' where email = 'your@email.com';

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  role text not null default 'editor' check (role in ('admin', 'editor')),
  created_at timestamptz not null default now()
);

create table if not exists public.editors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  name text not null,
  role text not null default 'Video Editor',
  shift text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.attendance_logs (
  id uuid primary key default gen_random_uuid(),
  editor_id uuid not null references public.editors(id) on delete restrict,
  action text not null check (action in ('in', 'break_start', 'break_end', 'out')),
  happened_at timestamptz not null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_work (
  id uuid primary key default gen_random_uuid(),
  editor_id uuid not null references public.editors(id) on delete restrict,
  work_date date not null,
  long_videos integer not null default 0,
  shorts integer not null default 0,
  thumbnails integer not null default 0,
  other_count integer not null default 0,
  details text,
  status text not null default 'completed' check (status in ('completed', 'in_progress', 'revision', 'blocked')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (editor_id, work_date)
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, display_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)), 'editor')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where user_id = auth.uid() and role = 'admin'
  );
$$;

alter table public.profiles enable row level security;
alter table public.editors enable row level security;
alter table public.attendance_logs enable row level security;
alter table public.daily_work enable row level security;

drop policy if exists "profiles select own or admin" on public.profiles;
create policy "profiles select own or admin"
on public.profiles for select
to authenticated
using (user_id = auth.uid() or public.is_admin());

drop policy if exists "profiles update admin" on public.profiles;
create policy "profiles update admin"
on public.profiles for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "editors select own or admin" on public.editors;
create policy "editors select own or admin"
on public.editors for select
to authenticated
using (public.is_admin() or user_id = auth.uid());

drop policy if exists "editors admin insert" on public.editors;
create policy "editors admin insert"
on public.editors for insert
to authenticated
with check (public.is_admin());

drop policy if exists "editors admin update" on public.editors;
create policy "editors admin update"
on public.editors for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "editors admin delete" on public.editors;
create policy "editors admin delete"
on public.editors for delete
to authenticated
using (public.is_admin());

drop policy if exists "attendance select own or admin" on public.attendance_logs;
create policy "attendance select own or admin"
on public.attendance_logs for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.editors e
    where e.id = attendance_logs.editor_id and e.user_id = auth.uid()
  )
);

drop policy if exists "attendance insert own or admin" on public.attendance_logs;
create policy "attendance insert own or admin"
on public.attendance_logs for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.is_admin()
    or exists (
      select 1 from public.editors e
      where e.id = attendance_logs.editor_id and e.user_id = auth.uid()
    )
  )
);

drop policy if exists "attendance admin update" on public.attendance_logs;
create policy "attendance admin update"
on public.attendance_logs for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "attendance admin delete" on public.attendance_logs;
create policy "attendance admin delete"
on public.attendance_logs for delete
to authenticated
using (public.is_admin());

drop policy if exists "daily work select own or admin" on public.daily_work;
create policy "daily work select own or admin"
on public.daily_work for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id and e.user_id = auth.uid()
  )
);

drop policy if exists "daily work insert own or admin" on public.daily_work;
create policy "daily work insert own or admin"
on public.daily_work for insert
to authenticated
with check (
  created_by = auth.uid()
  and (
    public.is_admin()
    or exists (
      select 1 from public.editors e
      where e.id = daily_work.editor_id and e.user_id = auth.uid()
    )
  )
);

drop policy if exists "daily work update own or admin" on public.daily_work;
create policy "daily work update own or admin"
on public.daily_work for update
to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id and e.user_id = auth.uid()
  )
)
with check (
  public.is_admin()
  or exists (
    select 1 from public.editors e
    where e.id = daily_work.editor_id and e.user_id = auth.uid()
  )
);

drop policy if exists "daily work admin delete" on public.daily_work;
create policy "daily work admin delete"
on public.daily_work for delete
to authenticated
using (public.is_admin());

insert into public.editors (name, role, shift, active)
select 'Atiq', 'Video Editor', '10:00 AM - 7:00 PM', true
where not exists (select 1 from public.editors where lower(name) = lower('Atiq'));

insert into public.editors (name, role, shift, active)
select 'Zain', 'Video Editor', '10:00 AM - 7:00 PM', true
where not exists (select 1 from public.editors where lower(name) = lower('Zain'));
