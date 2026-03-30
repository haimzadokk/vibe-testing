"""
vibe_auth.py — JWT auth layer for VIBE.TESTING cloud worker
Verifies Supabase-issued JWTs: HS256 via shared secret, ES256 via JWKS.

Required env vars:
  SUPABASE_JWT_SECRET  — Supabase Dashboard → Settings → API → JWT Secret (HS256 fallback)
  SUPABASE_URL         — e.g. https://YOUR_PROJECT.supabase.co (used to build JWKS URL)

Install:
  pip install "PyJWT==2.*"   # PyJWKClient is included in PyJWT >= 2.4

Usage in FastAPI routes:
  from vibe_auth import require_auth, require_admin, current_user
  from fastapi import Depends

  @app.get('/api/run/{run_id}')
  async def get_run(run_id: str, user = Depends(current_user)):
      # user = {'id': '...', 'email': '...', 'role': 'user' | 'admin'}

  @app.post('/api/admin/users')
  async def admin_endpoint(claims = Depends(require_admin)):
      pass  # only reaches here if role == 'admin'

  # /health must remain unprotected (UptimeRobot / Supabase keep-alive)
  @app.get('/health')
  async def health():
      return {'status': 'ok'}
"""

import os
import warnings
from datetime import timedelta
from functools import lru_cache

import jwt  # PyJWT >= 2.4
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPBearer
from fastapi.security.http import get_authorization_scheme_param

# ── Config ────────────────────────────────────────────────
_JWT_SECRET   = os.environ.get('SUPABASE_JWT_SECRET', '')
_SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
_AUDIENCE     = 'authenticated'  # Supabase sets aud='authenticated' on all user JWTs;
                                  # anon-key JWTs have aud='anon' and are rejected here
_LEEWAY       = timedelta(seconds=10)  # tolerate minor clock skew between Supabase and Render

# Kept for OpenAPI security schema only — NOT used for actual credential extraction
# in require_auth (see below for why).
_bearer = HTTPBearer(auto_error=False)

# Fail fast at import time so a misconfigured deploy surfaces immediately in logs,
# not silently as a 500 on the first real request.
if not _JWT_SECRET:
    warnings.warn(
        '[vibe_auth] SUPABASE_JWT_SECRET is not set — '
        'HS256 token verification will fail until this is configured.',
        RuntimeWarning,
        stacklevel=2,
    )
if not _SUPABASE_URL:
    warnings.warn(
        '[vibe_auth] SUPABASE_URL is not set — '
        'ES256 token verification will fail until this is configured.',
        RuntimeWarning,
        stacklevel=2,
    )


# ── JWKS client (cached) ──────────────────────────────────
@lru_cache(maxsize=1)
def _jwks_client() -> PyJWKClient:
    """
    Returns a cached PyJWKClient pointed at the Supabase JWKS endpoint.
    cache_keys=True means fetched public keys are kept in memory and only
    re-fetched when a new kid is seen — safe for long-running processes.
    """
    if not _SUPABASE_URL:
        raise RuntimeError('[vibe_auth] SUPABASE_URL is not set')
    jwks_url = _SUPABASE_URL.rstrip('/') + '/auth/v1/.well-known/jwks.json'
    return PyJWKClient(jwks_url, cache_keys=True)


# ── Core verifier ─────────────────────────────────────────
def _decode(token: str) -> dict:
    """
    Verify JWT signature, expiry, and audience.

    Routes verification based on the 'alg' field in the JWT header:
    - HS256: HMAC-SHA256 using SUPABASE_JWT_SECRET (legacy / non-rotated projects)
    - ES256: ECDSA P-256 using the Supabase JWKS endpoint (post-secret-rotation)

    - Expiry is enforced with a small leeway for clock skew.
    - Audience must be 'authenticated' — rejects anon tokens.
    - 'exp', 'sub', 'aud' are required fields; missing any → 401.

    Returns the full verified claims dict on success.
    NEVER returns claims from an unverified token.
    Raises HTTPException on any failure.
    """
    # Peek at the header (unverified) to determine the signing algorithm.
    # This is safe: we use the alg only to choose the verification path,
    # and the actual verification enforces the algorithm explicitly.
    try:
        header = jwt.get_unverified_header(token)
    except jwt.DecodeError:
        raise HTTPException(status_code=401, detail='invalid_token')

    alg = header.get('alg', 'HS256')

    try:
        if alg == 'HS256':
            if not _JWT_SECRET:
                raise HTTPException(status_code=500, detail='auth_misconfigured')
            claims = jwt.decode(
                token,
                _JWT_SECRET,
                algorithms=['HS256'],
                audience=_AUDIENCE,
                leeway=_LEEWAY,
                options={'require': ['exp', 'sub', 'aud']},
            )
        else:
            # ES256 (and any future JWKS-backed algorithm Supabase may introduce).
            # PyJWKClient fetches the matching public key by kid from the JWKS endpoint.
            try:
                signing_key = _jwks_client().get_signing_key_from_jwt(token)
            except Exception:
                raise HTTPException(status_code=401, detail='invalid_token')
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=[alg],
                audience=_AUDIENCE,
                leeway=_LEEWAY,
                options={'require': ['exp', 'sub', 'aud']},
            )
    except HTTPException:
        raise
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail='token_expired')
    except jwt.InvalidAudienceError:
        raise HTTPException(status_code=401, detail='invalid_audience')
    except jwt.InvalidTokenError:
        # Covers: bad signature, malformed token, missing required claims, etc.
        raise HTTPException(status_code=401, detail='invalid_token')

    return claims


# ── Dependencies ──────────────────────────────────────────
def require_auth(request: Request) -> dict:
    """
    FastAPI dependency — any verified user.

    Reads the raw Authorization header from the request directly.
    HTTPBearer(auto_error=False) is NOT used for extraction because it returns
    None for BOTH a missing header and a wrong scheme, making the two cases
    indistinguishable. Reading the raw header lets us distinguish all four cases:

      1. No Authorization header        → 401 missing_credentials
      2. Header present but malformed   → 401 missing_credentials
      3. Scheme present, not Bearer     → 401 invalid_scheme
      4. Bearer token present           → _decode() (invalid_token / expired / etc.)

    Returns the full decoded claims dict on success.
    """
    authorization = request.headers.get('Authorization')
    if not authorization:
        raise HTTPException(status_code=401, detail='missing_credentials')

    scheme, token = get_authorization_scheme_param(authorization)
    if not scheme or not token:
        # Header present but unparseable (e.g. bare "Bearer" with no value)
        raise HTTPException(status_code=401, detail='missing_credentials')
    if scheme.lower() != 'bearer':
        raise HTTPException(status_code=401, detail='invalid_scheme')

    return _decode(token)


def require_admin(claims: dict = Depends(require_auth)) -> dict:
    """
    FastAPI dependency — admin users only.

    Extends require_auth: additionally enforces app_role == 'admin'.

    app_role is read from verified JWT claims ONLY.
    It is injected server-side by Supabase's custom_access_token_hook.
    The role is NEVER read from the request body, query params, or headers.

    Returns the verified claims dict on success.
    Raises 403 if the role is absent or is not 'admin'.
    """
    if claims.get('app_role') != 'admin':
        raise HTTPException(status_code=403, detail='admin_required')
    return claims


def current_user(claims: dict = Depends(require_auth)) -> dict:
    """
    FastAPI dependency — verified user identity.

    Returns a clean user dict derived from verified claims:
      {'id': str, 'email': str, 'role': 'user' | 'admin'}

    Use this in any endpoint that needs to know WHO is making the request.
    This is the sole source of truth for user identity — never trust
    user-supplied id or role from the request.

    If app_role is absent (custom_access_token_hook not configured),
    role defaults to 'user' so the app degrades safely rather than crashing.
    """
    return {
        'id':    claims['sub'],           # always present — required by _decode
        'email': claims.get('email', ''),
        'role':  claims.get('app_role', 'user'),
    }
