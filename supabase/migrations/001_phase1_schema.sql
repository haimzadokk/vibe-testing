-- ============================================================
-- VIBE.TESTING — Phase 1 Schema Migration
-- File: 001_phase1_schema.sql
--
-- Run once in Supabase SQL Editor (Dashboard → SQL Editor → New query).
-- Idempotent: uses CREATE IF NOT EXISTS / OR REPLACE throughout.
-- ============================================================


-- ── Extensions ───────────────────────────────────────────
-- pgcrypto: gen_random_uuid() used as default PKs
create extension if not exists "pgcrypto";


-- ── Role helper ──────────────────────────────────────────
-- Reads app_role from the verified JWT already in context.
-- Used in every RLS policy to avoid repeated inline expressions.
-- security definer + fixed search_path prevents search-path injection.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.jwt() ->> 'app_role', 'user') = 'admin'
$$;

-- updated_at auto-refresh helper (shared by all tables that need it)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ════════════════════════════════════════════════════════════
-- TABLE: profiles
-- One row per auth.users entry.
-- Created automatically by handle_new_user trigger.
-- ════════════════════════════════════════════════════════════
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  role        text not null default 'user'
                check (role in ('user', 'admin')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles(role);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

-- RLS
alter table public.profiles enable row level security;

-- Users read their own profile.
create policy "profiles: user reads own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- Users update only their own profile, and cannot change their own role or email.
-- Role changes must be done by an admin or the service role directly.
-- Email is a mirror of auth.users.email — updated only by the sync trigger below.
create policy "profiles: user updates own (no role or email change)"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (
    id    = auth.uid()
    and role  = (select role  from public.profiles where id = auth.uid())
    and email = (select email from public.profiles where id = auth.uid())
  );

-- Admins read all profiles (e.g. user management dashboard).
create policy "profiles: admin reads all"
  on public.profiles for select
  to authenticated
  using (public.is_admin());


-- ── handle_new_user trigger ──────────────────────────────
-- Fires after every new row in auth.users.
-- Creates the corresponding profiles row with role='user'.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'user')
  on conflict (id) do nothing;   -- safe on any accidental re-fire
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Keep profiles.email in sync when the user changes their email in auth.users.
create or replace function public.handle_user_email_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute procedure public.handle_user_email_update();


-- ── custom_access_token_hook ─────────────────────────────
-- Injects app_role into every JWT minted by Supabase Auth.
-- Must be registered manually in Dashboard → Authentication → Hooks
-- (see integration notes at the bottom of this file).
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims    jsonb;
  user_role text;
begin
  claims := event -> 'claims';

  select role into user_role
  from public.profiles
  where id = (event ->> 'user_id')::uuid;

  -- If profile row does not exist yet (race on very first login), default to 'user'.
  claims := jsonb_set(claims, '{app_role}', to_jsonb(coalesce(user_role, 'user')));

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- Auth hook must be callable by supabase_auth_admin, and NOT by app roles.
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;


-- ════════════════════════════════════════════════════════════
-- TABLE: runs
-- One row per QA pipeline execution.
-- ════════════════════════════════════════════════════════════
create table if not exists public.runs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  status         text not null default 'pending'
                   check (status in ('pending', 'running', 'completed', 'failed')),
  target_type    text not null default 'spec'
                   check (target_type in ('spec', 'url', 'local')),
  target_label   text not null default '',
  pass_count     integer not null default 0,
  fail_count     integer not null default 0,
  skip_count     integer not null default 0,
  overall_status text
                   check (overall_status in ('pass', 'fail', 'partial', null)),
  duration_sec   numeric(8,1),
  summary        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists runs_user_id_idx   on public.runs(user_id);
create index if not exists runs_created_at_idx on public.runs(created_at desc);

drop trigger if exists runs_set_updated_at on public.runs;
create trigger runs_set_updated_at
  before update on public.runs
  for each row execute procedure public.set_updated_at();

-- RLS
alter table public.runs enable row level security;

create policy "runs: user manages own"
  on public.runs for all
  to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "runs: admin reads all"
  on public.runs for select
  to authenticated
  using (public.is_admin());


-- ════════════════════════════════════════════════════════════
-- TABLE: run_outputs
-- Stores the text content of each pipeline phase (STP, STD, STR).
-- user_id is denormalized to avoid joins in RLS checks.
-- ════════════════════════════════════════════════════════════
create table if not exists public.run_outputs (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references public.runs(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  output_type text not null
                check (output_type in ('stp', 'std', 'str', 'raw_text', 'script')),
  content     text not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists run_outputs_run_id_idx  on public.run_outputs(run_id);
create index if not exists run_outputs_user_id_idx on public.run_outputs(user_id);

-- RLS
alter table public.run_outputs enable row level security;

create policy "run_outputs: user manages own"
  on public.run_outputs for all
  to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "run_outputs: admin reads all"
  on public.run_outputs for select
  to authenticated
  using (public.is_admin());


-- ════════════════════════════════════════════════════════════
-- TABLE: jobs
-- Async work items claimed and processed by the cloud worker.
-- Workers operate via the service role (bypasses RLS).
-- user_id is denormalized for user-facing status queries.
-- ════════════════════════════════════════════════════════════
create table if not exists public.jobs (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid references public.runs(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  status       text not null default 'pending'
                 check (status in ('pending', 'claimed', 'running', 'done', 'failed')),
  payload      jsonb not null default '{}',
  result       jsonb,
  worker_id    text,                          -- which worker instance claimed this job
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  completed_at timestamptz
);

create index if not exists jobs_status_idx   on public.jobs(status) where status in ('pending', 'claimed');
create index if not exists jobs_user_id_idx  on public.jobs(user_id);
create index if not exists jobs_run_id_idx   on public.jobs(run_id);

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute procedure public.set_updated_at();

-- RLS
alter table public.jobs enable row level security;

-- Users can create jobs for themselves and read their own jobs' status.
-- Workers claim and update jobs via the service role — no RLS friction.
create policy "jobs: user inserts own"
  on public.jobs for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "jobs: user reads own"
  on public.jobs for select
  to authenticated
  using (user_id = auth.uid());

create policy "jobs: admin reads all"
  on public.jobs for select
  to authenticated
  using (public.is_admin());


-- ════════════════════════════════════════════════════════════
-- TABLE: uploaded_files
-- Metadata for files stored in the 'uploads' Storage bucket.
-- Actual bytes live in Storage; this table tracks them for RLS
-- and cleanup. run_id is nullable (files may be uploaded before a run).
-- ════════════════════════════════════════════════════════════
create table if not exists public.uploaded_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  run_id       uuid references public.runs(id) on delete set null,
  filename     text not null,
  storage_path text not null,           -- relative path inside the bucket
  file_type    text not null default '',
  file_size    integer not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists uploaded_files_user_id_idx on public.uploaded_files(user_id);
create index if not exists uploaded_files_run_id_idx  on public.uploaded_files(run_id);

-- RLS
alter table public.uploaded_files enable row level security;

create policy "uploaded_files: user manages own"
  on public.uploaded_files for all
  to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "uploaded_files: admin reads all"
  on public.uploaded_files for select
  to authenticated
  using (public.is_admin());


-- ════════════════════════════════════════════════════════════
-- TABLE: audit_logs
-- Append-only event log.
-- No UPDATE or DELETE RLS policies are defined — ever.
-- Only the service role (cloud worker / DB functions) can bypass
-- this restriction. Normal app code inserts via log_audit().
-- ════════════════════════════════════════════════════════════
create table if not exists public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  action        text not null,                 -- e.g. 'run.created', 'file.uploaded'
  resource_type text,                          -- e.g. 'run', 'job', 'file'
  resource_id   uuid,
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

create index if not exists audit_logs_user_id_idx   on public.audit_logs(user_id);
create index if not exists audit_logs_action_idx    on public.audit_logs(action);
create index if not exists audit_logs_created_at_idx on public.audit_logs(created_at desc);

-- RLS
alter table public.audit_logs enable row level security;

-- INSERT only — no update or delete policies defined anywhere.
-- Users must call log_audit() rather than inserting directly, so
-- user_id is always stamped server-side from auth.uid().
create policy "audit_logs: user reads own"
  on public.audit_logs for select
  to authenticated
  using (user_id = auth.uid());

create policy "audit_logs: admin reads all"
  on public.audit_logs for select
  to authenticated
  using (public.is_admin());

-- Convenience function for app code to write audit events.
-- security definer ensures user_id cannot be spoofed by the caller.
create or replace function public.log_audit(
  p_action        text,
  p_resource_type text  default null,
  p_resource_id   uuid  default null,
  p_metadata      jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_logs (user_id, action, resource_type, resource_id, metadata)
  values (auth.uid(), p_action, p_resource_type, p_resource_id, p_metadata);
end;
$$;

grant execute on function public.log_audit to authenticated;


-- ════════════════════════════════════════════════════════════
-- STORAGE: uploads bucket
-- Private bucket — no public access.
-- Path convention: uploads/{user_id}/{file}
-- Supabase Storage enforces these policies on storage.objects.
-- ════════════════════════════════════════════════════════════

-- Create the bucket (no-op if it already exists).
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', false)
on conflict (id) do nothing;

-- Users upload only into their own folder.
create policy "storage: user uploads own files"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users read their own files.
create policy "storage: user reads own files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Users delete their own files.
create policy "storage: user deletes own files"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Admins can read all uploaded files.
create policy "storage: admin reads all files"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'uploads'
    and public.is_admin()
  );
