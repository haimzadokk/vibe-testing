"""
vibe_worker.py — VIBE.TESTING Cloud Worker
FastAPI service hosted on Render (free tier).

Responsibilities:
  - Receive JWT-authenticated requests from index.html
  - Persist runs and phase outputs to Supabase (service role — bypasses RLS)
  - User isolation enforced manually from verified JWT claims, not from input
  - Audit logging on write operations

Start locally:
  uvicorn vibe_worker:app --host 0.0.0.0 --port 8000

Required env vars (see .env.example):
  SUPABASE_URL          — https://YOUR_PROJECT.supabase.co
  SUPABASE_SERVICE_KEY  — service_role key (NOT the anon key)
  SUPABASE_JWT_SECRET   — JWT Secret from Supabase Dashboard → Settings → API
  ALLOWED_ORIGINS       — comma-separated list of allowed CORS origins
                          e.g. https://yourdomain.com,http://localhost:5500
                          Default (dev only): http://localhost:5500,http://127.0.0.1:5500
                          Must be set explicitly in production.
"""

import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from supabase import Client, create_client

from vibe_auth import current_user, require_admin

# ── Config — fail fast if required vars are missing ───────
def _require_env(key: str) -> str:
    val = os.environ.get(key, '')
    if not val:
        raise RuntimeError(f'[vibe_worker] Required env var not set: {key}')
    return val

SUPABASE_URL         = _require_env('SUPABASE_URL')
SUPABASE_SERVICE_KEY = _require_env('SUPABASE_SERVICE_KEY')
# Auth uses Bearer tokens in the Authorization header — not cookies.
# allow_credentials=False is correct and avoids the browser restriction that
# forbids credentials=True together with a wildcard origin.
# If ALLOWED_ORIGINS is not set, fall back to localhost only (safe for local
# development; will block all cross-origin requests in a deployed environment,
# making a missing config a loud, obvious failure rather than a silent risk).
_ORIGINS_DEFAULT = 'http://localhost:5500,http://127.0.0.1:5500'
ALLOWED_ORIGINS  = [o.strip() for o in os.environ.get('ALLOWED_ORIGINS', _ORIGINS_DEFAULT).split(',')]

# ── Supabase client (service role) ────────────────────────
# Uses the service_role key — bypasses RLS on all queries.
# User isolation is therefore enforced here in application code,
# using user_id extracted from the verified JWT (never from request input).
_sb: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# ── FastAPI app ───────────────────────────────────────────
app = FastAPI(
    title='VIBE.TESTING Worker',
    docs_url=None,    # disable Swagger UI in production
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,   # Bearer token in Authorization header, not cookies
    allow_methods=['GET', 'POST', 'PATCH'],
    allow_headers=['Authorization', 'Content-Type'],
)

# ── Request / response models ─────────────────────────────
class CreateRunRequest(BaseModel):
    target_type:  str = Field(default='spec', pattern=r'^(spec|url|local)$')
    target_label: str = Field(default='', max_length=500)


class UpdateRunRequest(BaseModel):
    status:         Optional[str]   = Field(default=None, pattern=r'^(pending|running|completed|failed)$')
    pass_count:     Optional[int]   = Field(default=None, ge=0)
    fail_count:     Optional[int]   = Field(default=None, ge=0)
    skip_count:     Optional[int]   = Field(default=None, ge=0)
    overall_status: Optional[str]   = Field(default=None, pattern=r'^(pass|fail|partial)$')
    duration_sec:   Optional[float] = Field(default=None, ge=0)
    summary:        Optional[str]   = Field(default=None, max_length=1000)


class SaveOutputRequest(BaseModel):
    output_type: str = Field(..., pattern=r'^(stp|std|str|raw_text|script)$')
    content:     str = Field(..., max_length=500_000)   # ~500 KB per output


class UpsertPhaseStatusRequest(BaseModel):
    phase:         str           = Field(..., pattern=r'^(stp|std|run|str)$')
    status:        str           = Field(..., pattern=r'^(pending|running|completed|failed)$')
    error_message: Optional[str] = Field(default=None, max_length=500)


# ── Internal helpers ──────────────────────────────────────
def _validate_uuid(value: str) -> None:
    """
    Raise 404 (not 422) for malformed UUIDs.
    Using 404 avoids exposing route structure to scanners.
    """
    try:
        uuid.UUID(value)
    except ValueError:
        raise HTTPException(status_code=404, detail='not_found')


def _assert_run_owned(run_id: str, user_id: str) -> dict:
    """
    Fetch a run and verify it belongs to user_id.
    Returns the run row on success; raises 404 on not found or wrong owner.
    404 is used in both cases — avoids leaking whether a resource exists
    for a different user.
    """
    result = (
        _sb.table('runs')
        .select('*')
        .eq('id', run_id)
        .eq('user_id', user_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail='not_found')
    return result.data[0]


def _audit(
    user_id:       str,
    action:        str,
    resource_type: str  = None,
    resource_id:   str  = None,
    metadata:      dict = None,
) -> None:
    """
    Write an audit log row via the service role client.
    user_id always comes from the verified JWT — never from request input.
    Failures are swallowed so an audit hiccup never breaks the main operation.
    """
    try:
        _sb.table('audit_logs').insert({
            'user_id':       user_id,
            'action':        action,
            'resource_type': resource_type,
            'resource_id':   resource_id,
            'metadata':      metadata or {},
        }).execute()
    except Exception as exc:
        # Log to stdout so Render captures it; do not propagate.
        print(f'[vibe_worker] audit write failed: {exc}')


# ── Routes ────────────────────────────────────────────────

@app.get('/health')
def health():
    """
    Unprotected — must remain so.
    Used by UptimeRobot (keeps Render free tier awake) and
    optionally by Supabase Edge health checks.
    """
    return {'status': 'ok', 'auth': 'es256'}


@app.post('/api/runs', status_code=201)
def create_run(body: CreateRunRequest, user: dict = Depends(current_user)):
    """
    Create a new run for the authenticated user.
    user_id is always stamped from the verified JWT — the request body
    cannot influence which user the run belongs to.
    """
    row = {
        'user_id':      user['id'],
        'status':       'pending',
        'target_type':  body.target_type,
        'target_label': body.target_label,
    }
    result = _sb.table('runs').insert(row).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail='run_create_failed')

    run = result.data[0]
    _audit(
        user['id'], 'run.created',
        resource_type='run',
        resource_id=run['id'],
        metadata={'target_type': body.target_type, 'target_label': body.target_label},
    )
    return run


@app.get('/api/runs')
def list_runs(
    limit:  int = 50,
    offset: int = 0,
    user:   dict = Depends(current_user),
):
    """
    List runs for the authenticated user.
    The user_id filter comes from the verified JWT — not from query params.
    Heavy fields (raw outputs) are excluded; fetch /api/runs/{id} for those.
    """
    limit  = min(max(limit,  1), 100)
    offset = max(offset, 0)

    result = (
        _sb.table('runs')
        .select(
            'id, status, target_type, target_label, '
            'pass_count, fail_count, skip_count, overall_status, '
            'duration_sec, summary, created_at, updated_at'
        )
        .eq('user_id', user['id'])
        .order('created_at', desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    return {
        'runs':   result.data or [],
        'limit':  limit,
        'offset': offset,
    }


@app.get('/api/runs/{run_id}')
def get_run(run_id: str, user: dict = Depends(current_user)):
    """
    Fetch a single run with its phase outputs and per-phase status timeline.
    Ownership is verified server-side: user_id from JWT must match run.user_id.
    Returns 404 whether the run does not exist or belongs to another user.
    """
    _validate_uuid(run_id)
    run = _assert_run_owned(run_id, user['id'])

    outputs_result = (
        _sb.table('run_outputs')
        .select('id, output_type, content, created_at')
        .eq('run_id', run_id)
        .eq('user_id', user['id'])
        .order('created_at')
        .execute()
    )
    run['outputs'] = outputs_result.data or []

    # Per-phase lifecycle status, returned in logical pipeline order.
    # Missing phases are omitted (not all runs reach every phase).
    _PHASE_ORDER = ['stp', 'std', 'run', 'str']
    ps_result = (
        _sb.table('run_phase_status')
        .select('phase, status, started_at, completed_at, error_message, updated_at')
        .eq('run_id', run_id)
        .eq('user_id', user['id'])
        .execute()
    )
    ps_by_phase = {row['phase']: row for row in (ps_result.data or [])}
    run['phase_status'] = [ps_by_phase[p] for p in _PHASE_ORDER if p in ps_by_phase]

    return run


@app.patch('/api/runs/{run_id}')
def update_run(run_id: str, body: UpdateRunRequest, user: dict = Depends(current_user)):
    """
    Update mutable fields on a run (status, result counts, summary).
    Ownership is verified before any write.
    user_id is not a patchable field — it cannot be changed here.
    """
    _validate_uuid(run_id)
    _assert_run_owned(run_id, user['id'])

    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(status_code=422, detail='no_fields_to_update')

    result = (
        _sb.table('runs')
        .update(patch)
        .eq('id', run_id)
        .eq('user_id', user['id'])  # double-check ownership on the write itself
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail='update_failed')

    # Audit terminal state transitions only (not every intermediate update).
    if body.status in ('completed', 'failed'):
        _audit(
            user['id'], f'run.{body.status}',
            resource_type='run',
            resource_id=run_id,
            metadata={'status': body.status},
        )
    return result.data[0]


@app.get('/api/admin/runs')
def admin_list_runs(
    limit:  int = 100,
    offset: int = 0,
    _admin: dict = Depends(require_admin),
):
    """
    Admin-only: list all users' runs ordered by created_at desc.
    Returns run metadata + user email from profiles.
    Never returns run_outputs content (too large; fetch /api/runs/{id} as that user).
    """
    limit  = min(max(limit,  1), 200)
    offset = max(offset, 0)

    result = (
        _sb.table('runs')
        .select(
            'id, status, target_type, target_label, '
            'pass_count, fail_count, skip_count, overall_status, '
            'duration_sec, summary, created_at, updated_at, user_id'
        )
        .order('created_at', desc=True)
        .range(offset, offset + limit - 1)
        .execute()
    )
    runs = result.data or []

    # Fetch emails from profiles for all unique user_ids in one query.
    # runs.user_id → auth.users(id), profiles.id → auth.users(id).
    # No FK between runs and profiles exists, so we join manually.
    user_ids = list({r['user_id'] for r in runs if r.get('user_id')})
    email_map: dict = {}
    if user_ids:
        prof_result = (
            _sb.table('profiles')
            .select('id, email')
            .in_('id', user_ids)
            .execute()
        )
        email_map = {p['id']: p.get('email', '') for p in (prof_result.data or [])}
    for run in runs:
        run['user_email'] = email_map.get(run.get('user_id', ''), '')
    return {
        'runs':   runs,
        'limit':  limit,
        'offset': offset,
    }


@app.post('/api/runs/{run_id}/outputs', status_code=201)
def save_output(run_id: str, body: SaveOutputRequest, user: dict = Depends(current_user)):
    """
    Save a pipeline phase output (STP, STD, STR, script, raw_text) for a run.
    Parent run ownership is verified before inserting.
    user_id is always stamped from the JWT — not from the request body.
    """
    _validate_uuid(run_id)
    _assert_run_owned(run_id, user['id'])

    result = _sb.table('run_outputs').insert({
        'run_id':      run_id,
        'user_id':     user['id'],
        'output_type': body.output_type,
        'content':     body.content,
    }).execute()
    if not result.data:
        raise HTTPException(status_code=500, detail='output_save_failed')

    output = result.data[0]
    _audit(
        user['id'], 'output.saved',
        resource_type='run_output',
        resource_id=output['id'],
        metadata={'output_type': body.output_type, 'run_id': run_id},
    )
    return {'id': output['id'], 'output_type': output['output_type']}


@app.post('/api/runs/{run_id}/phase-status', status_code=200)
def upsert_phase_status(run_id: str, body: UpsertPhaseStatusRequest, user: dict = Depends(current_user)):
    """
    Upsert lifecycle status for a single pipeline phase (STP/STD/RUN/STR).
    Ownership is verified before any write.
    started_at is stamped on the 'running' transition.
    completed_at is stamped on 'completed' or 'failed'.
    error_message is only stored for 'failed'; omitted otherwise.
    A failure here must never surface to the frontend — callers swallow errors.
    """
    _validate_uuid(run_id)
    _assert_run_owned(run_id, user['id'])

    now = datetime.now(timezone.utc).isoformat()

    row: dict = {
        'run_id':     run_id,
        'user_id':    user['id'],
        'phase':      body.phase,
        'status':     body.status,
        'updated_at': now,
    }
    if body.status == 'running':
        row['started_at'] = now
    if body.status in ('completed', 'failed'):
        row['completed_at'] = now
    if body.status == 'failed' and body.error_message:
        row['error_message'] = body.error_message

    result = (
        _sb.table('run_phase_status')
        .upsert(row, on_conflict='run_id,phase')
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=500, detail='phase_status_upsert_failed')

    return {'ok': True, 'phase': body.phase, 'status': body.status}
