-- ============================================================
-- VIBE.TESTING — Phase 2 Schema Migration
-- File: 002_run_phase_status.sql
--
-- Adds per-phase lifecycle tracking to every pipeline run.
-- One row per (run_id, phase), upserted as phases progress.
--
-- Idempotent: safe to re-run.
-- Additive only: no existing tables or columns are modified.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- TABLE: run_phase_status
-- Tracks lifecycle of each pipeline phase (STP/STD/RUN/STR)
-- within a run. One row per (run_id, phase), upserted on
-- every state transition: pending → running → completed|failed.
-- ════════════════════════════════════════════════════════════
create table if not exists public.run_phase_status (
  id            uuid        primary key default gen_random_uuid(),
  run_id        uuid        not null references public.runs(id) on delete cascade,
  user_id       uuid        not null references auth.users(id) on delete cascade,
  phase         text        not null
                              check (phase in ('stp', 'std', 'run', 'str')),
  status        text        not null default 'pending'
                              check (status in ('pending', 'running', 'completed', 'failed')),
  started_at    timestamptz,
  completed_at  timestamptz,
  error_message text,
  updated_at    timestamptz not null default now(),

  -- enforce exactly one status row per phase per run
  unique (run_id, phase)
);

create index if not exists run_phase_status_run_id_idx  on public.run_phase_status(run_id);
create index if not exists run_phase_status_user_id_idx on public.run_phase_status(user_id);

-- keep updated_at current on every upsert
drop trigger if exists run_phase_status_set_updated_at on public.run_phase_status;
create trigger run_phase_status_set_updated_at
  before update on public.run_phase_status
  for each row execute procedure public.set_updated_at();

-- ── Row-Level Security ────────────────────────────────────
alter table public.run_phase_status enable row level security;

-- users can read, insert, and update their own rows
create policy "run_phase_status: user manages own"
  on public.run_phase_status for all
  to authenticated
  using  (user_id = auth.uid())
  with check (user_id = auth.uid());

-- admins can read all rows (read-only; writes still go through the worker)
create policy "run_phase_status: admin reads all"
  on public.run_phase_status for select
  to authenticated
  using (public.is_admin());
