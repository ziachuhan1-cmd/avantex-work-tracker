# Avantex Work Tracker - Supabase Setup

## Existing Project Upgrade

Run this file once in Supabase Dashboard > SQL Editor:

`multi-workspace-migration.sql`

This upgrades the app to a ClickUp-style workspace system:

- Multiple workspaces/agencies
- Owner, admin, and editor roles
- Invite links
- Workspace-level data isolation
- Existing Avantex data moved into `Avantex Work Tracker`

## Fresh Project Setup

For a totally new Supabase project:

1. Run `supabase-schema.sql`
2. Create your admin user in Authentication > Users
3. Mark your profile as admin if you are using the old bootstrap flow
4. Run `multi-workspace-migration.sql`
5. Login to the app and create/select a workspace

## Invite Flow

Owner/admin opens the app:

1. Go to `Editors`
2. Enter member email
3. Choose role: `Editor` or `Admin`
4. Click `Create Invite Link`
5. Send copied link to that person

The invited person opens the link, creates/logs into an account with the same email, and joins that workspace.

## Access Rules

- Owner/admin can see and manage the selected workspace.
- Editor can only see their own attendance and daily work.
- A user can belong to more than one workspace.
- One workspace cannot access another workspace's records.

## Current App Config

```text
Project URL: https://lrgqryhggolksgdhimci.supabase.co
Publishable anon key: sb_publishable_l0zZ3C1EAwZrOOMK6W4CTA_BwxMwdu3
```

## Sharing With Team

`http://127.0.0.1:8765/` works only on your computer. For editors to use it from their own devices, deploy this folder on a static host such as Netlify, Vercel, or Supabase Hosting.
