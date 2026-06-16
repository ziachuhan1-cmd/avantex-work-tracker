-- Avantex Work Tracker invite management functions
-- Run once in Supabase SQL Editor.

create or replace function public.cancel_workspace_invite(invite_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_workspace uuid;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  select workspace_id
  into invite_workspace
  from public.workspace_invites
  where id = invite_id;

  if invite_workspace is null then
    raise exception 'Invite not found';
  end if;

  if not public.has_workspace_role(invite_workspace, array['owner', 'admin']) then
    raise exception 'Only workspace admins can cancel invites';
  end if;

  delete from public.workspace_invites
  where id = invite_id
    and accepted_at is null;
end;
$$;
