# VIBE.TESTING — Phase 1 Integration & Validation Plan

## Files in scope

| File | Role |
|------|------|
| `auth.html` | Login / signup / password reset SPA |
| `index.html` | Main QA pipeline SPA (5-phase) |
| `vibe_auth.py` | JWT verification module for the cloud worker |
| `vibe_worker.py` | FastAPI cloud worker (Render) |
| `vibe-runner.py` | Local automation server (port 7474, unchanged) |
| `supabase/migrations/001_phase1_schema.sql` | DB schema, RLS, hooks |

---

## 1. Setup Order Checklist

Run in this exact sequence. Each step depends on the ones before it.

### 1.1 Supabase project

- [ ] Create a new Supabase project (free tier)
- [ ] Note: Project URL, anon key, service_role key, JWT Secret — all from Dashboard → Settings → API
- [ ] Dashboard → Authentication → Settings:
  - Enable **Email/Password** sign-in
  - Enable **Email confirmations** (required — auth guard checks `email_confirmed_at`)
  - Set **Site URL** to your frontend domain (e.g. `https://yourdomain.com`)
  - Add `https://yourdomain.com/auth.html` to **Redirect URLs** (for OAuth and recovery links)
- [ ] Dashboard → Authentication → Email Templates — verify confirmation and recovery templates look correct

### 1.2 Run the SQL migration

- [ ] Dashboard → SQL Editor → New query
- [ ] Paste and run `001_phase1_schema.sql` in full
- [ ] Verify no errors — all tables, triggers, functions, and policies should be created
- [ ] Confirm tables exist: Dashboard → Table Editor → check `profiles`, `runs`, `run_outputs`, `jobs`, `uploaded_files`, `audit_logs`

### 1.3 Register the custom_access_token_hook

- [ ] Dashboard → Authentication → Hooks
- [ ] Set **Custom Access Token** hook → `public.custom_access_token_hook`
- [ ] Save. Without this step `app_role` will never appear in JWTs.

### 1.4 Confirm the Storage bucket

- [ ] Dashboard → Storage — confirm bucket `uploads` exists and is **private**
- [ ] If missing: New bucket → name `uploads` → uncheck "Public bucket" → Create

### 1.5 Set the first admin

```sql
-- Run in SQL Editor after a user has signed up and confirmed their email
UPDATE public.profiles SET role = 'admin' WHERE email = 'your@email.com';
```

- [ ] Admin must sign out and back in to receive a JWT with `app_role: admin`

### 1.6 Replace placeholder config values

In `auth.html` — replace these three lines:
```javascript
var SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co'
var SUPABASE_ANON_KEY = 'YOUR_ANON_KEY'
var APP_URL           = 'https://YOUR_DOMAIN'
```

In `index.html` — replace these two lines (inside the auth guard block):
```javascript
var SUPABASE_URL      = 'https://YOUR_PROJECT.supabase.co'
var SUPABASE_ANON_KEY = 'YOUR_ANON_KEY'
```

### 1.7 Deploy the Python worker to Render

- [ ] Push `vibe_worker.py`, `vibe_auth.py`, `requirements.txt`, `Procfile` to a GitHub repo
- [ ] Render → New Web Service → connect repo
- [ ] Set environment variables in Render dashboard:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_KEY`  ← service_role key, never the anon key
  - `SUPABASE_JWT_SECRET`
  - `ALLOWED_ORIGINS` ← set to your actual frontend domain
- [ ] Start command: `uvicorn vibe_worker:app --host 0.0.0.0 --port $PORT`
- [ ] Wait for first deploy to succeed
- [ ] Confirm: `GET https://your-worker.onrender.com/health` returns `{"status":"ok"}`

### 1.8 Set up UptimeRobot (free tier keep-alive)

- [ ] UptimeRobot → New Monitor → HTTP(s) → URL: `https://your-worker.onrender.com/health`
- [ ] Interval: 5 minutes
- [ ] This prevents Render free tier cold starts during active use

### 1.9 Host auth.html and index.html

- [ ] Deploy both files to your hosting (GitHub Pages, Netlify, or any static host)
- [ ] Confirm `auth.html` and `index.html` are served from the same origin (important for `redirect()` helper)
- [ ] Confirm the hosting URL matches `APP_URL` in `auth.html` and the `ALLOWED_ORIGINS` in the worker

### 1.10 Enable Google OAuth (optional, phase 1)

- [ ] Google Cloud Console → Create OAuth 2.0 Client ID
- [ ] Add Supabase callback URL: `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
- [ ] Dashboard → Authentication → Providers → Google → paste Client ID + Secret → Enable
- [ ] Add your frontend URL to Google's Authorized redirect URIs

---

## 2. End-to-End Test Plan

### 2.1 Auth flows

**A — New user signup**
1. Open `auth.html` directly
2. Click "אין לך חשבון? הירשם"
3. Fill email + password → submit
4. Expect: "הרשמה בוצעה — בדוק את המייל" message + verify view shown
5. Open confirmation email → click link
6. Expect: redirect to `index.html`
7. Verify `profiles` row created in Supabase with `role = 'user'`
8. Verify JWT (browser console: `window.VIBE_USER`) contains `role: 'user'`

**B — Login with verified account**
1. Open `auth.html`
2. Enter valid credentials → submit
3. Expect: redirect to `index.html` within ~1 second
4. Verify `window.VIBE_USER` is set: `{ id, email, role }`

**C — Login with unverified account**
1. Sign up but do not confirm email
2. Attempt login
3. Expect: redirected to verify view, not to `index.html`

**D — Wrong password**
1. Enter valid email + wrong password
2. Expect: error message shown in login view, no redirect

**E — Forgot password flow**
1. Click "שכחתי סיסמה"
2. Enter email → submit
3. Expect: "קישור לאיפוס נשלח" message
4. Open recovery email → click link
5. Expect: `auth.html` loads with reset view visible
6. Enter new password → submit
7. Expect: redirect to login with "הסיסמה עודכנה" message
8. Login with new password → confirm access

**F — Google OAuth**
1. Click "המשך עם Google" on login or signup view
2. Complete Google consent
3. Expect: redirect to `index.html`
4. Verify `profiles` row created (via trigger)

**G — Direct index.html access without session**
1. Clear localStorage (`localStorage.clear()` in console)
2. Navigate to `index.html`
3. Expect: immediate redirect to `auth.html` (fast-path guard fires)

**H — Expired session**
1. Log in, then manually delete the Supabase auth key from localStorage
2. Reload `index.html`
3. Expect: redirect to `auth.html` (fast-path fires, or SDK guard fires on stale token)

**I — Logout**
1. While on `index.html`, call `logout()` in browser console
2. Expect: redirect to `auth.html?msg=logged_out`
3. Expect: "יצאת מהמערכת בהצלחה" shown in login view

### 2.2 Worker API flows

Run these with a valid JWT from a logged-in browser session.
Extract the token: `JSON.parse(localStorage.getItem('sb-YOUR_REF-auth-token')).access_token`

**J — Create a run**
```
POST /api/runs
Authorization: Bearer <token>
{ "target_type": "url", "target_label": "https://example.com" }
```
Expect: 201 + run object with `user_id` matching the JWT `sub` claim

**K — List runs**
```
GET /api/runs
Authorization: Bearer <token>
```
Expect: 200 + `{ runs: [...] }` containing only the current user's runs

**L — Get single run**
```
GET /api/runs/<run_id>
Authorization: Bearer <token>
```
Expect: 200 + run with `outputs: []`

**M — Cross-user isolation**
1. Create a run as User A, note the `run_id`
2. Authenticate as User B, request `GET /api/runs/<run_id_from_A>`
3. Expect: 404 (not 403 — no ownership leak)

**N — No auth header**
```
GET /api/runs  (no Authorization header)
```
Expect: 401 `missing_credentials`

**O — Invalid token**
```
GET /api/runs
Authorization: Bearer notavalidtoken
```
Expect: 401 `invalid_token`

**P — Wrong scheme**
```
GET /api/runs
Authorization: Basic dXNlcjpwYXNz
```
Expect: 401 `invalid_scheme`

### 2.3 VIBE pipeline integration

**Q — Full 5-phase run (AI Simulation)**
1. Log in → land on `index.html`
2. Phase 1 (STP): upload a test file or paste a URL → Generate
3. Expect: STP content appears in phase output panel
4. Phase 2 (STD): Generate test design from STP
5. Expect: STD content appears
6. Phase 3 (RUN): select AI Simulation → Run
7. Expect: RUN progress shown, results appear
8. Phase 4 (STR): Generate test report
9. Expect: STR markdown report rendered
10. Phase 5 (Reports): check report appears in history list

**R — Full run with local runner (vibe-runner.py)**
1. Start `python vibe-runner.py` locally
2. Confirm RUNNER ✓ badge appears in `index.html` header
3. Repeat phases Q3–Q5 with Real Automation selected
4. Expect: runner is invoked, actual results returned

---

## 3. Security Verification Checklist

### JWT / auth

- [ ] `GET /api/runs` with no Authorization header → 401 (not 403, not 200)
- [ ] `GET /api/runs` with `Authorization: Basic xxx` → 401 `invalid_scheme`
- [ ] `GET /api/runs` with a syntactically valid but wrong-secret JWT → 401 `invalid_token`
- [ ] `GET /api/runs` with an expired JWT → 401 `token_expired`
- [ ] `GET /api/runs` with an anon-key JWT (`aud: anon`) → 401 `invalid_audience`
- [ ] Valid JWT → worker returns only the authenticated user's data

### Role enforcement

- [ ] User with `role: user` cannot reach any admin-only endpoint (if added later)
- [ ] Promote a user to admin in DB → sign out → sign back in → confirm `window.VIBE_USER.role === 'admin'`
- [ ] Demote the user back → repeat → confirm role reverts

### User isolation (Supabase RLS)

- [ ] Sign in as User A, create a run. Sign in as User B (different browser/incognito): `GET /api/runs` returns empty or only B's runs
- [ ] User B cannot fetch User A's run by ID (404)
- [ ] In Supabase SQL Editor, confirm `SELECT * FROM runs WHERE user_id != auth.uid()` returns 0 rows when called as a non-admin user (test via Supabase API with user JWT)

### audit_logs integrity

- [ ] Confirm no `UPDATE` or `DELETE` policy exists on `audit_logs`: run `SELECT * FROM pg_policies WHERE tablename = 'audit_logs'` — should show only `SELECT` policies
- [ ] Attempt `DELETE FROM audit_logs` via Supabase JS client with user JWT → must fail with RLS error
- [ ] After creating a run via the worker, confirm an `audit_logs` row with `action = 'run.created'` exists

### Session handling

- [ ] Manually delete Supabase auth key from localStorage → reload `index.html` → redirected to `auth.html`
- [ ] Confirm `auth.html?msg=logged_out` shows "יצאת מהמערכת בהצלחה"
- [ ] Confirm `auth.html?msg=session_expired` shows the correct error message
- [ ] Confirm `auth.html` does not show login form briefly before redirect when a valid session exists (init-loading state working)

### Token handling

- [ ] After Google OAuth or email confirm, verify the URL is clean (no `token_hash` or `code` in address bar)
- [ ] Confirm no access token appears in browser history or URL bar at any point

### CORS

- [ ] Request to worker from an origin NOT in `ALLOWED_ORIGINS` → browser blocks the response (no CORS headers returned for disallowed origins)
- [ ] Request with `Authorization` header from an allowed origin → succeeds

---

## 4. Regression Checklist — Existing UI/UX

Verify all existing VIBE.TESTING functionality is unbroken after the auth layer is added.

### Core pipeline

- [ ] Phase 1 (STP): file upload works — PDF, DOCX, TXT, MD, JSON, YAML, HTML
- [ ] Phase 1 (STP): URL input works
- [ ] Phase 1 (STP): local app path input works
- [ ] Phase 2 (STD): generates from STP content
- [ ] Phase 3 (RUN): mode picker (AI Simulation / Real Automation) visible and functional
- [ ] Phase 3 (RUN): connection panel works (URL / token / credentials)
- [ ] Phase 3 (RUN): target selection (spec / url / local window) works
- [ ] Phase 3 (RUN): RUN onboarding modal appears on first visit, dismissable permanently
- [ ] Phase 4 (STR): generates from run results, streaming does not freeze the page
- [ ] Phase 5 (Reports): past runs shown in dashboard, localStorage cache fallback works

### Header & server badge

- [ ] RUNNER ✓ badge appears when `vibe-runner.py` is running
- [ ] LOCAL badge shown when runner is offline
- [ ] Badge polling does not throw errors in console

### Settings overlay

- [ ] Settings overlay opens and closes
- [ ] Font size slider works
- [ ] Light / dark mode toggle works
- [ ] Line height control works
- [ ] Heading scale control works
- [ ] Auto-scroll toggle works
- [ ] INFO page renders

### Chat panel

- [ ] Chat panel opens
- [ ] Sends a message → receives conversational AI response (does NOT trigger generation)
- [ ] Phase context is reflected in responses

### Email delivery

- [ ] Post-run email panel appears
- [ ] Sending with valid SMTP config (`.env`) succeeds
- [ ] Correct error shown when SMTP is not configured

### Auth guard — no UI regression

- [ ] Auth guard does not block `index.html` from loading for authenticated users
- [ ] No visible flash of login state or blank screen on load for authenticated users
- [ ] `window.VIBE_USER` is defined before any app code runs
- [ ] `logout()` function is globally available and callable from console

### Mobile — auth.html

- [ ] Auth card scrollable on screens shorter than 700px (iPhone SE, Galaxy S8)
- [ ] All form fields reachable without horizontal scroll
- [ ] iOS Safari: no zoom on input focus (font-size 16px on inputs)
- [ ] iOS Safari: password field shows/hides toggle works
- [ ] Google OAuth button: icon is on the left of text even in RTL layout
- [ ] Hebrew text is right-aligned throughout
- [ ] "שכחתי סיסמה" / "חזור להתחברות" navigation works on mobile
- [ ] Verify email view scrolls correctly on small screens

### Mobile — index.html

- [ ] Phase navigation tabs usable on mobile
- [ ] Phase output panels readable on mobile
- [ ] No layout breaks introduced by the auth guard block (JS-only change, no HTML/CSS)

---

## 5. Deployment Validation Checklist

### Render (free tier)

- [ ] Worker deploys without build errors
- [ ] `/health` responds within 3 seconds on a warm instance
- [ ] Cold start (after ~15 min idle): `/health` responds within 35 seconds
- [ ] UptimeRobot monitor is active and pinging `/health` every 5 minutes
- [ ] `SUPABASE_SERVICE_KEY` is set as a secret env var (not visible in logs)
- [ ] Worker logs show `[vibe_auth]` warning if `SUPABASE_JWT_SECRET` is missing — confirm it is NOT logged in production
- [ ] Worker returns 401 (not 500) for all unauthenticated requests — confirms env vars loaded correctly

### Supabase (free tier)

- [ ] Project is not paused (free tier pauses after 1 week of inactivity)
- [ ] UptimeRobot ping to `/health` keeps the Render worker alive; the worker's Supabase queries keep Supabase alive simultaneously
- [ ] Confirm database size is under 500 MB (free tier limit)
- [ ] Confirm Auth users count is under 50,000 (free tier limit)
- [ ] Storage: confirm `uploads` bucket is private (not publicly accessible by URL)

### Static hosting (auth.html / index.html)

- [ ] Both files served over HTTPS (required for Supabase Auth redirects)
- [ ] `auth.html` and `index.html` on the same origin (redirect helper uses `window.location.origin`)
- [ ] No browser console errors on initial load of either file
- [ ] Supabase redirect URL whitelist includes the exact hosting URL

### End-to-end smoke test (post-deploy, 5 minutes)

Run after every deploy of any component:

1. Open `https://yourdomain.com/index.html` in a private window → should redirect to `auth.html`
2. Sign in with a valid account → should redirect to `index.html`
3. `window.VIBE_USER` in console → should show `{ id, email, role }`
4. `GET https://your-worker.onrender.com/health` → `{"status":"ok"}`
5. Phase 1: generate STP from a pasted URL → content appears
6. `logout()` in console → redirects to `auth.html` with "יצאת מהמערכת"
7. Open `index.html` again → redirects back to `auth.html` (session cleared)

All 7 steps passing = deployment is valid.
