# ReverseSandbox Platform Upgrade Plan

## 1. Architecture Overview

### Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Runtime** | Node.js (ESM) | Already in use; no new runtime needed |
| **Framework** | Express.js | Mature, huge ecosystem, simple session/middleware support |
| **Database** | SQLite via better-sqlite3 | Zero-ops, single-file, synchronous API (perfect for prototype) |
| **Auth** | Auth0 (Universal Login) | Hosted login page — no custom login UI to build/secure. Frontend uses Auth0 SPA SDK, backend validates JWTs |
| **Payments** | Stripe Checkout | Hosted payment page — PCI compliant with zero card handling |
| **Sessions** | express-session + connect-sqlite3 | Server-side sessions stored in SQLite; session cookie over HTTPS |
| **Templating** | Vanilla HTML (inline `<script>`) | Matches existing approach; no build step needed |

### Request Flow

```
Browser → Cloudflare Tunnel → 127.0.0.1:4025 (Express)
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
              Static files    API routes      Auth callbacks
             (index.html,    (/api/*)        (/callback,
              terms, etc.)                    /dashboard)
                                │
                          ┌─────┼─────┐
                          │           │
                     SQLite DB    Stripe API
```

---

## 2. Directory Structure

```
reversesandbox-landing/
├── package.json              # NEW — dependencies & scripts
├── serve.mjs                 # REPLACED by server.mjs
├── server.mjs                # NEW — Express app entry point
├── db/
│   ├── schema.sql            # NEW — DDL for all tables
│   ├── migrate.mjs           # NEW — runs schema.sql on startup
│   └── reversesandbox.db     # NEW — SQLite database file (gitignored)
├── routes/
│   ├── auth.mjs              # NEW — Auth0 callback, logout, /me
│   ├── api.mjs               # NEW — balance, activity, stripe endpoints
│   └── webhooks.mjs          # NEW — Stripe webhook handler
├── middleware/
│   ├── auth.mjs              # NEW — requireAuth middleware (validates session)
│   └── logging.mjs           # NEW — activity logging helper
├── lib/
│   ├── db.mjs                # NEW — better-sqlite3 instance + helpers
│   └── stripe.mjs            # NEW — Stripe client + checkout session creation
├── public/                   # NEW — static files directory
│   ├── index.html            # MOVED from root
│   ├── terms.html            # MOVED from root
│   ├── privacy.html          # MOVED from root
│   ├── refund.html           # MOVED from root
│   ├── dashboard.html        # NEW — authenticated user dashboard
│   ├── login-redirect.html   # NEW — thin page that triggers Auth0 login
│   └── js/
│       └── auth.js           # NEW — Auth0 SPA SDK init, login/logout helpers
├── .env                      # NEW — secrets (gitignored)
├── .env.example              # NEW — template for .env
├── .gitignore                # UPDATED — add .env, *.db
└── PLAN.md                   # This file
```

---

## 3. Database Schema

### `users` table

```sql
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    auth0_sub     TEXT    NOT NULL UNIQUE,    -- Auth0 user ID (e.g. "auth0|abc123")
    email         TEXT    NOT NULL,
    name          TEXT    NOT NULL DEFAULT '',
    balance       INTEGER NOT NULL DEFAULT 0, -- cents (integer math, no floats)
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_auth0_sub ON users(auth0_sub);
CREATE INDEX idx_users_email ON users(email);
```

> **Balance is stored in cents** (integer). $10.00 = 1000. This avoids floating-point rounding issues.

### `activity_log` table

```sql
CREATE TABLE IF NOT EXISTS activity_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    event_type TEXT    NOT NULL,  -- 'registration', 'login', 'logout', 'payment', 'credit'
    metadata   TEXT    DEFAULT '{}',  -- JSON blob
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_activity_user ON activity_log(user_id);
CREATE INDEX idx_activity_type ON activity_log(event_type);
CREATE INDEX idx_activity_created ON activity_log(created_at);
```

### `payments` table

```sql
CREATE TABLE IF NOT EXISTS payments (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               INTEGER NOT NULL REFERENCES users(id),
    stripe_session_id     TEXT    NOT NULL UNIQUE,
    stripe_payment_intent TEXT,
    amount_cents          INTEGER NOT NULL,  -- amount in cents
    status                TEXT    NOT NULL DEFAULT 'pending', -- 'pending', 'completed', 'failed'
    created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    completed_at          TEXT
);
CREATE INDEX idx_payments_user ON payments(user_id);
CREATE INDEX idx_payments_session ON payments(stripe_session_id);
```

---

## 4. API Routes

### Auth Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/callback` | No | Auth0 redirect callback — exchanges code for tokens, creates/updates user, sets session |
| GET | `/logout` | No | Clears session, redirects to Auth0 logout, then home |
| GET | `/api/me` | Yes | Returns current user profile + balance |

### Dashboard Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/dashboard` | Yes | Serves dashboard.html (redirects to login if no session) |

### Payment Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/checkout` | Yes | Creates Stripe Checkout Session. Body: `{ amount: 500 }` (cents). Returns `{ url }` |
| GET | `/api/checkout/success` | Yes | Post-payment redirect landing — shows confirmation, redirects to dashboard |
| GET | `/api/checkout/cancel` | Yes | Cancelled payment redirect — returns to dashboard |
| POST | `/api/webhooks/stripe` | No* | Stripe webhook endpoint. Verifies signature, credits balance. (*Raw body, no session needed) |

### Activity Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/activity` | Yes | Returns recent activity log for current user. Query: `?limit=20&offset=0` |

### Static Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | index.html |
| GET | `/terms` | terms.html (or `/terms.html`) |
| GET | `/privacy` | privacy.html |
| GET | `/refund` | refund.html |
| GET | `/*` | Static file serving from `public/` |

---

## 5. Auth0 Setup Instructions for K

### Step 1: Create Auth0 Account & Tenant

1. Go to https://auth0.com and sign up (free tier is sufficient)
2. Create a tenant (e.g., `reversesandbox`)

### Step 2: Create Application

1. Go to **Applications → Create Application**
2. Name: `ReverseSandbox`
3. Type: **Regular Web Application**
4. Go to the **Settings** tab and configure:

| Setting | Value |
|---------|-------|
| **Allowed Callback URLs** | `https://www.reversesandbox.com/callback, http://localhost:4025/callback` |
| **Allowed Logout URLs** | `https://www.reversesandbox.com, http://localhost:4025` |
| **Allowed Web Origins** | `https://www.reversesandbox.com, http://localhost:4025` |

5. Note down these values (needed for `.env`):
   - **Domain** (e.g., `reversesandbox.us.auth0.com`)
   - **Client ID**
   - **Client Secret**

### Step 3: Configure Social Login (Optional)

1. Go to **Authentication → Social**
2. Enable Google if desired (good for B2B users)

### Step 4: Customize Login Page (Optional)

1. Go to **Branding → Universal Login**
2. Set primary color to `#8b5cf6` (matches site accent)
3. Upload logo if desired
4. Set background color to `#0a0a0f`

### Step 5: Enable Email Verification

1. Go to **Authentication → Database → Username-Password-Authentication**
2. Ensure "Requires email verification" is ON

---

## 6. Stripe Setup Instructions for K

### Step 1: Stripe Account

1. Go to https://dashboard.stripe.com and sign up or log in
2. Complete business verification (Reverse Sandbox LLC)

### Step 2: Get API Keys

1. Go to **Developers → API keys**
2. Note down:
   - **Publishable key** (`pk_live_...` or `pk_test_...`)
   - **Secret key** (`sk_live_...` or `sk_test_...`)

### Step 3: Create Webhook

1. Go to **Developers → Webhooks → Add endpoint**
2. Endpoint URL: `https://www.reversesandbox.com/api/webhooks/stripe`
3. Events to listen for:
   - `checkout.session.completed`
   - `checkout.session.expired`
4. Note down the **Webhook signing secret** (`whsec_...`)

### Step 4: Create Product (Optional but Recommended)

1. Go to **Products → Add product**
2. Name: `Account Credit`
3. Description: `Add funds to your ReverseSandbox account`
4. This product is used for Checkout Session line items

### Step 5: Test Mode

- Use test keys during development
- Test card: `4242 4242 4242 4242`, any future expiry, any CVC

---

## 7. Frontend Pages & Components

### Navigation Update (All Pages)

Add to the existing nav bar:
- **Logged out**: "Sign In" button (right side, ghost style) → triggers Auth0 login
- **Logged in**: User avatar/name dropdown → "Dashboard" link + "Sign Out"

This requires a small `<script>` on every page that checks `/api/me` and swaps nav content.

### dashboard.html

New page, matching existing dark theme. Sections:

1. **Header Bar**
   - "Welcome back, {name}" greeting
   - Account balance displayed prominently (large font, green color)

2. **Quick Actions**
   - "Add Funds" button → opens amount picker modal
   - Amount presets: $5, $10, $25, $50 (styled as pill buttons)
   - "Custom Amount" option (input field, min $1, max $500)
   - "Continue to Payment →" → POST /api/checkout → redirect to Stripe

3. **Profile Card**
   - Name, email
   - Member since date
   - Last login

4. **Activity Feed**
   - Scrollable list of recent events
   - Each entry: icon + event description + timestamp
   - Event types styled differently (login=blue, payment=green, etc.)
   - "Load more" pagination

### auth.js (Shared Script)

Lightweight script included on all pages:
- On load: fetch `/api/me` to check auth state
- If authenticated: swap nav to show user name + dashboard link + logout
- If not authenticated: show "Sign In" button
- Provides `login()` and `logout()` functions

---

## 8. Implementation Phases

### Phase 1: Project Setup & Static Migration
- Initialize `package.json` with dependencies
- Move HTML files into `public/`
- Create `server.mjs` with Express serving static files from `public/`
- Verify all existing pages still work at same URLs
- Update `.gitignore`

### Phase 2: Database
- Create `db/schema.sql`
- Create `lib/db.mjs` (init better-sqlite3, run migrations on startup)
- Verify DB creation and table structure

### Phase 3: Auth0 Integration
- Add `openid-client` (or `express-openid-connect`) dependency
- Create `routes/auth.mjs` with callback, logout
- Create `middleware/auth.mjs` with session validation
- Add session middleware (express-session + connect-sqlite3)
- Create user on first login, update `last_login_at` on subsequent logins
- Log registration and login events to `activity_log`
- Add auth state detection to all pages (nav update)

### Phase 4: Dashboard
- Create `public/dashboard.html` with full UI
- Create `/api/me` endpoint
- Create `/api/activity` endpoint
- Wire up dashboard to fetch and display user data
- Protect `/dashboard` behind auth middleware

### Phase 5: Stripe Integration
- Create `lib/stripe.mjs`
- Create `/api/checkout` endpoint (creates Checkout Session)
- Create `/api/webhooks/stripe` endpoint (verifies signature, credits balance)
- Create success/cancel redirect pages
- Add "Add Funds" flow to dashboard
- Log payment events to `activity_log`

### Phase 6: Polish & Hardening
- Error handling on all routes
- Rate limiting on API endpoints
- CSRF protection on state-changing endpoints
- Input validation/sanitization
- Test the full flow end-to-end
- Update policy pages if needed (mention account balances in terms)

---

## 9. Environment Variables

```bash
# .env.example

# Server
PORT=4025
HOST=127.0.0.1
NODE_ENV=production
SESSION_SECRET=<random-64-char-string>

# Auth0
AUTH0_DOMAIN=<your-tenant>.us.auth0.com
AUTH0_CLIENT_ID=<client-id>
AUTH0_CLIENT_SECRET=<client-secret>
AUTH0_CALLBACK_URL=https://www.reversesandbox.com/callback
AUTH0_BASE_URL=https://www.reversesandbox.com

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Database
DB_PATH=./db/reversesandbox.db
```

---

## 10. Security Considerations

### Authentication & Sessions
- **Server-side sessions only** — no JWTs stored in localStorage (XSS-proof)
- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`
- Session store in SQLite (persists across server restarts)
- Auth0 handles password hashing, brute-force protection, MFA

### Payments
- **Never handle card data** — Stripe Checkout is fully hosted
- Webhook signature verification on every Stripe event (reject unverified)
- Idempotency: check `stripe_session_id` uniqueness before crediting balance
- Balance updates use SQLite transactions

### Web Security
- Helmet.js middleware for security headers (CSP, HSTS, X-Frame-Options, etc.)
- CSRF: SameSite cookies + check Origin header on state-changing POSTs
- Rate limiting on `/api/checkout` and `/callback` (prevent abuse)
- Input validation: amount must be integer, within bounds (100–50000 cents)

### Data
- SQLite DB file permissions: readable only by app user
- `.env` file in `.gitignore` — never committed
- No PII logged beyond what's needed (no passwords, no card numbers)
- Balance stored as integer cents — no floating-point arithmetic

### Infrastructure
- Server binds to `127.0.0.1` only — not accessible from network
- Cloudflare Tunnel provides TLS termination and DDoS protection
- Stripe webhook endpoint is the only route accepting external POST without session

### Dependency Choices

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^4 | HTTP framework |
| better-sqlite3 | ^11 | SQLite driver |
| express-openid-connect | ^2 | Auth0 integration (handles OIDC flow, session, middleware) |
| express-session | ^1 | Session management |
| connect-sqlite3 | ^0.9 | SQLite session store |
| stripe | ^17 | Stripe API client |
| helmet | ^8 | Security headers |
| express-rate-limit | ^7 | Rate limiting |
| dotenv | ^16 | Environment variable loading |

> **Note on `express-openid-connect`**: This is Auth0's official Express SDK. It wraps `openid-client`, manages sessions, provides `requiresAuth()` middleware, and handles the entire OIDC flow (authorization code + PKCE). This dramatically simplifies Phase 3.
