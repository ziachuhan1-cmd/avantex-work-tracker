-- Avantex Flow chat module
-- Run once in Supabase SQL Editor.

create table if not exists public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_type text not null check (thread_type in ('direct', 'group')),
  title text not null,
  member_editor_ids uuid[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  thread_id uuid not null references public.chat_threads(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  sender_editor_id uuid references public.editors(id) on delete set null,
  body text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  created_at timestamptz not null default now()
);

create index if not exists chat_threads_workspace_updated_idx
on public.chat_threads(workspace_id, updated_at desc);

create index if not exists chat_messages_thread_created_idx
on public.chat_messages(thread_id, created_at asc);

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;

create or replace function public.can_access_chat_thread(target_thread_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.chat_threads t
    left join public.editors e
      on e.workspace_id = t.workspace_id
      and e.user_id = auth.uid()
      and e.active = true
    where t.id = target_thread_id
      and (
        public.has_workspace_role(t.workspace_id, array['owner', 'admin'])
        or e.id = any(t.member_editor_ids)
      )
  );
$$;

create or replace function public.can_create_chat_thread(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.workspace_id = target_workspace_id
      and m.user_id = auth.uid()
      and m.active = true
      and m.role in ('owner', 'admin', 'member')
  );
$$;

drop policy if exists "chat threads select" on public.chat_threads;
create policy "chat threads select"
on public.chat_threads for select
to authenticated
using (public.can_access_chat_thread(id));

drop policy if exists "chat threads insert admins" on public.chat_threads;
drop policy if exists "chat threads insert workspace members" on public.chat_threads;
create policy "chat threads insert workspace members"
on public.chat_threads for insert
to authenticated
with check (public.can_create_chat_thread(workspace_id));

drop policy if exists "chat threads update admins" on public.chat_threads;
create policy "chat threads update admins"
on public.chat_threads for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

drop policy if exists "chat messages select" on public.chat_messages;
create policy "chat messages select"
on public.chat_messages for select
to authenticated
using (public.can_access_chat_thread(thread_id));

drop policy if exists "chat messages insert participants" on public.chat_messages;
create policy "chat messages insert participants"
on public.chat_messages for insert
to authenticated
with check (
  public.can_access_chat_thread(thread_id)
  and exists (
    select 1 from public.chat_threads t
    where t.id = thread_id
      and t.workspace_id = chat_messages.workspace_id
  )
);
