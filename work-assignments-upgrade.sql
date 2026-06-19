-- Avantex Work Tracker assignments module
-- Run once in Supabase SQL Editor.

create table if not exists public.work_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  assigned_to uuid not null references public.editors(id) on delete cascade,
  assigned_by uuid references auth.users(id) on delete set null,
  title text not null,
  work_type text not null default 'Other',
  work_url text,
  notes text,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'assigned' check (status in ('assigned', 'in_progress', 'submitted', 'approved', 'revision', 'help')),
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.work_assignments enable row level security;

drop policy if exists "assignments select workspace" on public.work_assignments;
create policy "assignments select workspace"
on public.work_assignments for select
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1
    from public.editors e
    where e.id = work_assignments.assigned_to
      and e.user_id = auth.uid()
      and e.active = true
  )
);

drop policy if exists "assignments admins insert" on public.work_assignments;
create policy "assignments admins insert"
on public.work_assignments for insert
to authenticated
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "assignments update allowed" on public.work_assignments;
create policy "assignments update allowed"
on public.work_assignments for update
to authenticated
using (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1
    from public.editors e
    where e.id = work_assignments.assigned_to
      and e.user_id = auth.uid()
      and e.active = true
  )
)
with check (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1
    from public.editors e
    where e.id = work_assignments.assigned_to
      and e.user_id = auth.uid()
      and e.active = true
  )
);

drop policy if exists "assignments admins delete" on public.work_assignments;
create policy "assignments admins delete"
on public.work_assignments for delete
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']));

create index if not exists work_assignments_workspace_idx on public.work_assignments(workspace_id);
create index if not exists work_assignments_assigned_to_idx on public.work_assignments(assigned_to);
