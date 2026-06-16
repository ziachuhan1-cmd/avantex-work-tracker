-- Avantex Work Tracker invite accept function fix
-- Run once in Supabase SQL Editor.

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
  limit 1;

  if invite_row.id is null then
    raise exception 'Invite is invalid';
  end if;

  if invite_row.accepted_at is null and invite_row.expires_at <= now() then
    raise exception 'Invite is expired';
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
  where id = invite_row.id
    and accepted_at is null;

  return invite_row.workspace_id;
end;
$$;
