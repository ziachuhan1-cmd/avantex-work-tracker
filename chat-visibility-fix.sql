-- Avantex Flow chat visibility fix
-- Run after chat-rpc-fix.sql if messages send but members cannot see them.

create or replace function public.can_access_workspace_chat(target_workspace_id uuid)
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

drop policy if exists "chat threads select" on public.chat_threads;
create policy "chat threads select"
on public.chat_threads for select
to authenticated
using (public.can_access_workspace_chat(workspace_id));

drop policy if exists "chat messages select" on public.chat_messages;
create policy "chat messages select"
on public.chat_messages for select
to authenticated
using (public.can_access_workspace_chat(workspace_id));
