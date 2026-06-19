-- Avantex Flow chat RLS insert fix
-- Run once after chat-upgrade.sql.

drop policy if exists "chat threads insert admins" on public.chat_threads;
drop policy if exists "chat threads insert workspace members" on public.chat_threads;

create policy "chat threads insert workspace members"
on public.chat_threads for insert
to authenticated
with check (
  public.has_workspace_role(workspace_id, array['owner', 'admin'])
  or exists (
    select 1
    from public.memberships m
    where m.workspace_id = chat_threads.workspace_id
      and m.user_id = auth.uid()
      and m.active = true
  )
);

drop policy if exists "chat messages insert participants" on public.chat_messages;
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
