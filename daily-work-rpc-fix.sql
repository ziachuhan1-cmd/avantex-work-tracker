-- Avantex Flow daily work save RPC
-- Run once in Supabase SQL Editor after the main schema.

create or replace function public.save_daily_work_rpc(
  target_editor_id uuid,
  target_work_date date,
  target_long_videos integer default 0,
  target_shorts integer default 0,
  target_thumbnails integer default 0,
  target_other_count integer default 0,
  target_details text default null,
  target_status text default 'submitted'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  editor_row public.editors%rowtype;
  saved_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Login required.';
  end if;

  select *
  into editor_row
  from public.editors
  where id = target_editor_id;

  if editor_row.id is null then
    raise exception 'Team member not found.';
  end if;

  if coalesce(editor_row.active, true) = false then
    raise exception 'This member has been removed from the workspace.';
  end if;

  if not (
    public.has_workspace_role(editor_row.workspace_id, array['owner', 'admin'])
    or editor_row.user_id = auth.uid()
  ) then
    raise exception 'You can only update your own work.';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.workspace_id = editor_row.workspace_id
      and m.user_id = coalesce(editor_row.user_id, auth.uid())
      and coalesce(m.active, true) = true
  ) and not public.has_workspace_role(editor_row.workspace_id, array['owner', 'admin']) then
    raise exception 'Workspace access is not active.';
  end if;

  insert into public.daily_work (
    workspace_id,
    editor_id,
    work_date,
    long_videos,
    shorts,
    thumbnails,
    other_count,
    details,
    status,
    created_by,
    updated_at
  )
  values (
    editor_row.workspace_id,
    target_editor_id,
    target_work_date,
    greatest(coalesce(target_long_videos, 0), 0),
    greatest(coalesce(target_shorts, 0), 0),
    greatest(coalesce(target_thumbnails, 0), 0),
    greatest(coalesce(target_other_count, 0), 0),
    nullif(target_details, ''),
    coalesce(nullif(target_status, ''), 'submitted'),
    auth.uid(),
    now()
  )
  on conflict (workspace_id, editor_id, work_date)
  do update set
    long_videos = excluded.long_videos,
    shorts = excluded.shorts,
    thumbnails = excluded.thumbnails,
    other_count = excluded.other_count,
    details = excluded.details,
    status = excluded.status,
    updated_at = now()
  returning id into saved_id;

  return saved_id;
end;
$$;

grant execute on function public.save_daily_work_rpc(
  uuid,
  date,
  integer,
  integer,
  integer,
  integer,
  text,
  text
) to authenticated;
