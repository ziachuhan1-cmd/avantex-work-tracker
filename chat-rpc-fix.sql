-- Avantex Flow chat RPC fix
-- Run this in Supabase SQL Editor after chat-upgrade.sql.

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
        public.has_workspace_role(t.workspace_id, array['owner', 'admin'])
        or e.id = any(t.member_editor_ids)
      )
  );
$$;

create or replace function public.create_chat_thread_rpc(
  target_workspace_id uuid,
  target_thread_type text,
  target_title text,
  target_member_editor_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_thread_id uuid;
  clean_title text;
begin
  if not public.can_create_chat_thread(target_workspace_id) then
    raise exception 'Not allowed to create chat in this workspace';
  end if;

  if target_thread_type not in ('direct', 'group') then
    raise exception 'Invalid chat type';
  end if;

  if target_thread_type = 'group'
     and not public.has_workspace_role(target_workspace_id, array['owner', 'admin']) then
    raise exception 'Only workspace admins can create group chats';
  end if;

  clean_title := nullif(trim(coalesce(target_title, '')), '');
  if clean_title is null then
    clean_title := case when target_thread_type = 'group' then 'Group Chat' else 'Direct Chat' end;
  end if;

  insert into public.chat_threads (
    workspace_id,
    thread_type,
    title,
    member_editor_ids,
    created_by,
    updated_at
  )
  values (
    target_workspace_id,
    target_thread_type,
    clean_title,
    coalesce(target_member_editor_ids, '{}'),
    auth.uid(),
    now()
  )
  returning id into new_thread_id;

  return new_thread_id;
end;
$$;

create or replace function public.send_chat_message_rpc(
  target_thread_id uuid,
  message_body text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_workspace_id uuid;
  sender_editor uuid;
  new_message_id uuid;
  clean_body text;
begin
  clean_body := nullif(trim(coalesce(message_body, '')), '');
  if clean_body is null then
    raise exception 'Message is empty';
  end if;

  select workspace_id into target_workspace_id
  from public.chat_threads
  where id = target_thread_id;

  if target_workspace_id is null then
    raise exception 'Chat thread not found';
  end if;

  if not public.can_access_chat_thread(target_thread_id) then
    raise exception 'Not allowed to send message in this chat';
  end if;

  select id into sender_editor
  from public.editors
  where workspace_id = target_workspace_id
    and user_id = auth.uid()
    and coalesce(active, true) = true
  order by created_at desc
  limit 1;

  insert into public.chat_messages (
    workspace_id,
    thread_id,
    sender_id,
    sender_editor_id,
    body
  )
  values (
    target_workspace_id,
    target_thread_id,
    auth.uid(),
    sender_editor,
    clean_body
  )
  returning id into new_message_id;

  update public.chat_threads
  set updated_at = now()
  where id = target_thread_id;

  return new_message_id;
end;
$$;

grant execute on function public.create_chat_thread_rpc(uuid, text, text, uuid[]) to authenticated;
grant execute on function public.send_chat_message_rpc(uuid, text) to authenticated;
