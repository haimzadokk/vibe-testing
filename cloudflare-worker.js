/**
 * vibe-testing-proxy — Cloudflare Worker
 *
 * Proxies requests to the Anthropic API.
 * Requires a valid Supabase JWT in the Authorization header.
 *
 * Required Worker environment variables (set in Cloudflare Dashboard → Settings → Variables):
 *   ANTHROPIC_API_KEY   — your Anthropic API key (secret)
 *   SUPABASE_JWT_SECRET — the JWT secret from your Supabase project settings (secret)
 */

const ALLOWED_ORIGIN = 'https://haimzadokk.github.io';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // ── AUTH: optional Supabase JWT (app is open-access) ─────
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    let payload = null;
    if (token && env.SUPABASE_JWT_SECRET) {
      payload = await verifySupabaseJWT(token, env.SUPABASE_JWT_SECRET);
    }
    // No auth required — open access
    // ─────────────────────────────────────────────────────────

    // ── RATE LIMITING: 20 req/min per IP or user ─────────────
    const userId = (payload && payload.sub) ? payload.sub : (request.headers.get('CF-Connecting-IP') || 'anon');
    const windowKey = Math.floor(Date.now() / 60000); // 1-minute window
    if (!globalThis._rateMap) globalThis._rateMap = new Map();
    // Clean stale windows (keep memory bounded)
    for (const [k] of globalThis._rateMap) {
      if (!k.endsWith(':' + windowKey)) globalThis._rateMap.delete(k);
    }
    const mapKey = `${userId}:${windowKey}`;
    const reqCount = (globalThis._rateMap.get(mapKey) || 0) + 1;
    globalThis._rateMap.set(mapKey, reqCount);
    if (reqCount > 20) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Try again in a minute.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
    // ─────────────────────────────────────────────────────────

    // Forward to Anthropic
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    // ── PAYLOAD ENFORCEMENT: pin model, cap tokens, limit messages ──
    const safeBody = {
      model:     'claude-sonnet-4-20250514',
      max_tokens: Math.min(Number(body.max_tokens) || 4000, 4000),
      messages:  Array.isArray(body.messages) ? body.messages.slice(0, 20) : [],
      stream:    body.stream === true,
    };
    if (body.system && typeof body.system === 'string') {
      safeBody.system = body.system.slice(0, 2000);
    }
    // ────────────────────────────────────────────────────────────────

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(safeBody),
    });

    return new Response(anthropicResp.body, {
      status: anthropicResp.status,
      headers: {
        'Content-Type': anthropicResp.headers.get('Content-Type') || 'application/json',
        ...CORS_HEADERS,
      },
    });
  },
};

/**
 * Verifies a Supabase-issued JWT (HS256) against the project's JWT secret.
 * Returns the decoded payload if valid, or null if invalid/expired.
 */
async function verifySupabaseJWT(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    // Decode payload (no signature check yet) to read exp and sub
    const payload = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')),
          c => c.charCodeAt(0)
        )
      )
    );

    // Reject expired tokens
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    // Verify HMAC-SHA256 signature
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const sigInput = new TextEncoder().encode(parts[0] + '.' + parts[1]);
    const sigBytes = Uint8Array.from(
      atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );

    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, sigInput);
    return valid ? payload : null;
  } catch {
    return null;
  }
}
