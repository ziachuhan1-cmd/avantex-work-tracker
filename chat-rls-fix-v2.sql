-- Avantex Flow chat RLS fix v2
-- Run this once in Supabase SQL Editor if chat thread/message insert is blocked.

create or replace function public.can_create_chat_thread(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.has_workspace_role(target_workspace_id, array['owner', 'admin'])
    or exists (
      select 1
      from public.memberships m
      where m.workspace_id = target_workspace_id
        and m.user_id = auth.uid()
        and coalesce(m.active, true) = true
    )
    or exists (
      select 1
      from public.editors e
      where e.workspace_id = target_workspace_id
        and e.user_id = auth.uid()
        and coalesce(e.active, true) = true
    );
$$;

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
      and coalesce(e.active, true) = true
    where t.id = target_thread_id
      and (
        public.can_create_chat_thread(t.workspace_id)
        or e.id = any(t.member_editor_ids)
      )
  );
$$;

drop policy if exists "chat threads insert admins" on public.chat_threads;
drop policy if exists "chat threads insert workspace members" on public.chat_threads;
drop policy if exists "chat threads select" on public.chat_threads;
drop policy if exists "chat threads update admins" on public.chat_threads;
drop policy if exists "chat messages select" on public.chat_messages;
drop policy if exists "chat messages insert participants" on public.chat_messages;

create policy "chat threads select"
on public.chat_threads for select
to authenticated
using (public.can_access_chat_thread(id));

create policy "chat threads insert workspace members"
on public.chat_threads for insert
to authenticated
with check (public.can_create_chat_thread(workspace_id));

create policy "chat threads update admins"
on public.chat_threads for update
to authenticated
using (public.has_workspace_role(workspace_id, array['owner', 'admin']))
with check (public.has_workspace_role(workspace_id, array['owner', 'admin']));

create policy "chat messages select"
on public.chat_messages for select
to authenticated
using (public.can_access_chat_thread(thread_id));

create policy "chat messages insert participants"
on public.chat_messages for insert
to authenticated
with check (
  public.can_access_chat_thread(thread_id)
  and exists (
    select 1
    from public.chat_threads t
    where t.id = thread_id
      and t.workspace_id = chat_messages.workspace_id
  )
);
