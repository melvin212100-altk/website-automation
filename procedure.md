EARNINGS PLATFORM — COMPLETE BUILD SPECIFICATION (v1)
Audience: a separate AI builder (e.g. another code-generation agent) that has NO prior context about this project, no uploaded zip, and no chat history. This document is the single source of truth. If anything is not written here, the builder MUST stop and ask — it MUST NOT invent behavior.

Author role: Lead Developer (not "an AI"). All decisions below are deliberate; they are not suggestions, they are the spec.

0. PRIME DIRECTIVES (READ FIRST — VIOLATIONS = REJECTED BUILD)
These rules override any habit, any "best practice", and any prior training the builder has.

Build ONLY what is in this document. No bonus features, no "nice-to-have" pages, no extra dashboards, no AI chatbots, no gamification, no newsletter signups, no cookie banners unless specified. If you think something is missing, STOP and ask.
Do NOT invent numbers, fees, percentages, durations, currencies, or limits. All economic values are listed in §2. If a value is missing for a feature you are asked to build, STOP and ask.
Do NOT invent API endpoints, table names, or field names. They are listed in §5 and §7. Use them verbatim.
Money math = integer cents (USDT has 6 decimals → use integer "micro-USDT" = value × 1_000_000). NEVER use JavaScript number for balances. Use bigint or string-decimal (decimal.js). Rounding rule: floor to 6 decimals on credit, floor on debit, never round up in user's favor.
Idempotency is mandatory on every money-moving operation. Every deposit, withdrawal, daily-earning credit, and WhatsApp OTP send MUST carry a unique idempotency_key. Re-processing the same key MUST be a no-op.
The Binance API key used by the server MUST NOT have "Enable Withdrawals" permission. Withdrawals are queued and require a separate signed worker (§6.4). No exceptions.
The WhatsApp service is a SEPARATE process on a SEPARATE host. It is not part of the main web app. They communicate only via authenticated HTTPS + HMAC-signed webhooks (§8). Do not merge them.
No whatsapp-web.js, no Puppeteer, no Chromium, no QR scanning in production. Use the official WhatsApp Cloud API (Meta). Reason: stability, compliance, no browser dependency, free tier covers OTPs.
Secrets are NEVER in code, NEVER in the repo, NEVER in VITE_* vars. Server-only env vars only. Frontend gets a publishable key at most.
Every state transition is logged to an append-only transaction_audit table. Never UPDATE balances without inserting a corresponding ledger row in the same DB transaction.
All admin actions require 2FA (TOTP) AND are logged. No "admin = any user with a flag" shortcuts. Admin role lives in a separate user_roles table.
RLS (Row-Level Security) is ON for every user-data table. Default policy = deny. Add explicit per-role policies.
No SELECT * to the client. Only explicit columns. Never expose email, whatsapp_number, binance_address, or internal IDs to other users.
When in doubt → ask, don't guess. Hallucination cost is higher than delay cost.
1. PRODUCT SUMMARY (the "what")
A web platform where a user:

Registers (email + password + WhatsApp number, verified by OTP).
Deposits USDT (TRC20) via Binance (detected automatically — user is not asked to upload screenshots).
Each deposit becomes an Investment.
Each investment pays 10% of the deposited principal per day, for exactly 20 days, then stops. Total payout = 200% of deposit (principal is included in the 200%, i.e. user gets 2× back, no separate "principal return").
User can withdraw any amount ≥ $2 USDT from their available balance, at any time (no daily cooldown).
Every deposit, every daily earning credit, and every withdrawal triggers a personalized WhatsApp message to the user's verified number, sent by an external service.
Sensitive actions (login from new device, withdrawal request, password change, WhatsApp number change) require an OTP delivered via WhatsApp.
Out of scope for v1 (do not build): referrals, multi-tier plans, leaderboards, in-app chat, mobile app, fiat on-ramp, multiple cryptocurrencies, staking, NFTs.

2. ECONOMIC RULES (HARD-CODED CONSTANTS — store in platform_config table, not in code)
Key	Value	Notes
currency	USDT	Single currency, v1.
network	TRC20	Single network, v1. Lower fees than ERC20.
min_deposit_usdt	10.00	Below = ignored, funds parked in unallocated_deposits for admin review.
max_deposit_usdt	10000.00	Above = held pending admin review.
daily_return_pct	10	Of original deposit principal.
investment_term_days	20	Hard stop. Day 21 = 0 earning, investment status = completed.
total_return_multiplier	2.0	Sanity check: sum of daily credits MUST equal 2× principal.
min_withdrawal_usdt	2.00	Below = rejected with error code MIN_WITHDRAWAL.
withdrawal_fee_usdt	1.00	Flat fee. Subtracted from withdrawn amount, not from balance separately. User receives amount - 1.
withdrawal_cooldown_seconds	0	No cooldown. Any time.
max_pending_withdrawals_per_user	3	Prevents queue spam.
daily_credit_run_time_utc	00:05	Cron runs 5 min after UTC midnight.
otp_ttl_seconds	300	5 min.
otp_max_attempts	5	Per OTP code. Then code is burned.
otp_resend_cooldown_seconds	60	
Edge cases — REQUIRED behavior:

Multiple deposits: each is its OWN investment with its OWN 20-day clock. They do not merge.
Withdrawal vs. ongoing earnings: withdrawals come from available_balance, NOT from locked_principal. Daily credits move money from "future earnings" into available_balance.
Partial-day: if deposit confirmed at 18:00 UTC on day N, day 1's credit fires at 00:05 UTC on day N+1. No prorated partial day.
Investment completed: status flips to completed, no further credits, principal is NOT returned (it was already paid out across the 20 days as part of the 200%).
Refunds / chargebacks: not possible (on-chain). Any reversal is manual admin via signed action.
3. ARCHITECTURE (the "shape")
┌─────────────────────────┐         ┌──────────────────────────┐
│  Main Web App           │         │  WhatsApp Notifier        │
│  (TanStack Start +      │  HTTPS  │  Service (Node.js,        │
│   Lovable Cloud =       │◀───────▶│   separate host, e.g.     │
│   Supabase/Postgres)    │  HMAC   │   Railway / Fly / VPS)    │
│                         │         │   Talks to Meta WhatsApp  │
│                         │         │   Cloud API only.         │
└──────────┬──────────────┘         └──────────────────────────┘
           │
           │ Binance Spot REST API (HMAC-signed, READ + DEPOSIT-ADDRESS
           │ only — NO withdraw permission on this key)
           ▼
┌─────────────────────────┐
│  Binance                │
└─────────────────────────┘

           ┌──────────────────────────┐
           │  Withdrawal Signer       │
           │  Worker (separate, can   │
           │  be same host as         │
           │  WhatsApp service or a   │
           │  different one. Holds    │
           │  the WITHDRAW-enabled    │
           │  Binance key. Polls the  │
           │  main DB for approved    │
           │  withdrawals, signs,     │
           │  submits, reports back   │
           │  via webhook.)           │
           └──────────────────────────┘
Three independent processes. Reason: blast radius. If the WhatsApp host is compromised, the attacker cannot touch funds. If the web app is compromised, the attacker cannot send withdrawals (no key). If the signer is compromised, attacker can only withdraw to whitelisted addresses Binance already approved.

4. TECH STACK (NON-NEGOTIABLE)
Main app:

TanStack Start v1 (React 19, Vite 7)
Lovable Cloud (Supabase Postgres + Auth + Storage + Edge runtime via TanStack server functions / server routes)
Tailwind v4 with semantic tokens in src/styles.css (oklch). No raw color classes in components.
Zod for ALL input validation (server functions + server routes).
TanStack Query for data loading.
shadcn/ui for components.
WhatsApp service (separate repo):

Node.js 20 LTS, TypeScript, Fastify or Express.
Official whatsapp-cloud-api SDK or raw fetch to https://graph.facebook.com/v20.0/{phone_number_id}/messages.
Redis (Upstash free tier) for outbound queue + dedupe.
Hosted on Railway / Fly.io / Render (user's choice — document the deploy steps).
Withdrawal signer (separate repo or same as WhatsApp service):

Node.js 20 LTS.
node-binance-api or raw signed fetch.
Polls main app via authenticated endpoint every 30s OR receives push via webhook.
Forbidden:

whatsapp-web.js, Puppeteer, Selenium, Chromium.
Edge Functions on Supabase (use TanStack server functions instead — already documented in this template).
MySQL, MongoDB, Firebase, Prisma. (Use Supabase Postgres via the integration's client.)
React Router DOM, Next.js patterns, "use server" directive.
Storing balances as number / float.
5. DATABASE SCHEMA (canonical — use these names verbatim)
All tables in public schema. All have created_at timestamptz default now(). RLS enabled on every one. GRANTs per the public-schema-grants rule (authenticated for user tables, service_role for everything, anon only where explicitly public).

-- 5.1 profiles (1:1 with auth.users)
profiles(
  id uuid PK references auth.users(id) on delete cascade,
  whatsapp_number text not null,               -- E.164, e.g. +254712345678
  whatsapp_verified_at timestamptz,
  display_name text,
  country_code text,                            -- ISO 3166-1 alpha-2
  available_balance_micro bigint not null default 0,  -- USDT × 1e6
  total_deposited_micro bigint not null default 0,
  total_withdrawn_micro bigint not null default 0,
  total_earned_micro bigint not null default 0,
  status text not null default 'active',        -- active | frozen | banned
  created_at, updated_at
)

-- 5.2 user_roles (NEVER store role on profiles)
app_role enum('user','admin','support')
user_roles(id, user_id, role, unique(user_id, role))
-- + has_role(uuid,app_role) SECURITY DEFINER function per project rules.

-- 5.3 deposits
deposits(
  id uuid PK default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  amount_micro bigint not null,
  network text not null default 'TRC20',
  tx_hash text not null unique,                 -- on-chain tx id, dedupe key
  binance_deposit_id text unique,               -- Binance's internal id
  status text not null,                         -- detected | confirmed | credited | rejected
  confirmations int not null default 0,
  confirmed_at timestamptz,
  credited_at timestamptz,
  raw_payload jsonb,                            -- full Binance response, for audit
  created_at
)

-- 5.4 investments (1 per deposit, created when deposit becomes 'credited')
investments(
  id uuid PK,
  user_id uuid not null,
  deposit_id uuid not null unique references deposits(id),
  principal_micro bigint not null,
  daily_credit_micro bigint not null,           -- = principal_micro / 10
  start_date date not null,                     -- = (credited_at + 1 day) at UTC
  end_date date not null,                       -- = start_date + 19 days
  days_credited int not null default 0,         -- 0..20
  total_credited_micro bigint not null default 0,
  status text not null default 'active',        -- active | completed | cancelled
  created_at, updated_at
)

-- 5.5 earnings_ledger (one row per daily credit — append-only)
earnings_ledger(
  id uuid PK,
  investment_id uuid not null references investments(id),
  user_id uuid not null,
  credit_date date not null,
  amount_micro bigint not null,
  idempotency_key text not null unique,         -- = investment_id || ':' || credit_date
  created_at
)
-- The unique constraint on idempotency_key is the ENTIRE guarantee against
-- double-paying a day. Do not add ON CONFLICT DO UPDATE — only DO NOTHING.

-- 5.6 withdrawals
withdrawals(
  id uuid PK,
  user_id uuid not null,
  requested_amount_micro bigint not null,       -- what user typed
  fee_micro bigint not null,                    -- = 1_000_000
  net_amount_micro bigint not null,             -- requested - fee, what hits chain
  destination_address text not null,
  network text not null default 'TRC20',
  status text not null,                         -- pending | approved | broadcasting | sent | failed | cancelled
  binance_withdrawal_id text unique,
  tx_hash text,
  otp_id uuid not null references otps(id),     -- required: WD must have a verified OTP
  approved_by uuid references auth.users(id),   -- admin user id
  approved_at timestamptz,
  sent_at timestamptz,
  failure_reason text,
  created_at, updated_at
)

-- 5.7 otps
otps(
  id uuid PK,
  user_id uuid not null,
  purpose text not null,         -- 'signup'|'login'|'withdrawal'|'change_whatsapp'|'change_password'
  code_hash text not null,       -- bcrypt of the 6-digit code (NEVER store plaintext)
  attempts int not null default 0,
  consumed_at timestamptz,
  expires_at timestamptz not null,
  created_at
)

-- 5.8 whatsapp_outbox (main app writes, WhatsApp service reads)
whatsapp_outbox(
  id uuid PK,
  user_id uuid not null,
  to_number text not null,       -- E.164
  template_name text not null,   -- 'otp'|'deposit_received'|'daily_earning'|'withdrawal_sent'|...
  payload jsonb not null,        -- template variables
  idempotency_key text not null unique,
  status text not null default 'queued',   -- queued | sending | sent | failed
  attempts int not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at
)

-- 5.9 transaction_audit (append-only, EVERY balance change)
transaction_audit(
  id bigserial PK,
  user_id uuid not null,
  kind text not null,            -- deposit_credit | earning_credit | withdrawal_debit | admin_adjustment
  amount_micro bigint not null,  -- signed: + credit, - debit
  balance_before_micro bigint not null,
  balance_after_micro bigint not null,
  ref_table text not null,       -- 'deposits'|'earnings_ledger'|'withdrawals'|...
  ref_id uuid not null,
  actor uuid,                    -- user_id or admin id; null = system cron
  notes text,
  created_at
)

-- 5.10 platform_config (key/value, see §2)
platform_config(key text PK, value jsonb not null, updated_by uuid, updated_at)

-- 5.11 admin_actions (every admin click logged)
admin_actions(id, admin_id, action, target_table, target_id, before jsonb, after jsonb, created_at)

-- 5.12 binance_deposit_addresses (one per user, cached from Binance)
binance_deposit_addresses(user_id PK, address text not null, address_tag text, network text, generated_at)
Critical SQL rules:

All money operations happen inside a single BEGIN; ... COMMIT; that updates profiles.available_balance_micro AND inserts into transaction_audit. Both or neither.
Use SELECT ... FOR UPDATE on the user's profile row before debiting (prevents concurrent withdrawal double-spend).
Daily cron uses INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING *. If returned row count = 0, that day was already credited — skip.
6. SERVER LOGIC (server functions + server routes)
All in the main app. Each one MUST: validate input with Zod, check auth, write audit row, return typed DTO.

6.1 Auth (use Supabase Auth)
Email + password. Email confirmation OFF in v1 (we use WhatsApp OTP as the real verification).
On signup, profile row is created via trigger. User MUST verify WhatsApp before deposit address is shown.
6.2 Server functions (createServerFn, in src/lib/*.functions.ts)
requestOtp({ purpose }) → creates OTP, queues whatsapp_outbox row.
verifyOtp({ otp_id, code }) → verifies, marks consumed.
setWhatsappNumber({ number }) → starts change flow (OTP to old + new).
getDepositAddress() → returns cached, or calls Binance /sapi/v1/capital/deposit/address.
getMyBalances() → returns profile balances + active investments summary.
listMyInvestments({ cursor }) → paginated.
listMyDeposits({ cursor }), listMyWithdrawals({ cursor }).
requestWithdrawal({ amount_micro, destination_address, otp_id, code }):
Verify OTP.
SELECT ... FOR UPDATE on profile.
Validate min, max-pending, balance.
Debit balance, insert audit, insert withdrawal status=pending.
Queue WhatsApp "withdrawal received, pending review" message.
Admin: approveWithdrawal, rejectWithdrawal, freezeUser, adjustBalance (all gated by has_role(uid,'admin') AND fresh 2FA).
6.3 Server routes (src/routes/api/public/*, signature-verified)
POST /api/public/binance/deposit-webhook — if using Binance Pay merchant webhook. HMAC verify with BINANCE_WEBHOOK_SECRET.
POST /api/public/whatsapp/delivery-receipt — from WhatsApp service. HMAC-verified.
POST /api/public/signer/withdrawal-result — from withdrawal signer worker. HMAC-verified.
GET /api/public/health — liveness only, no data.
6.4 Cron jobs (use Supabase pg_cron calling a server function via pg_net, OR an external scheduler hitting /api/public/cron/* with HMAC)
Every 2 minutes: pollBinanceDeposits() — call /sapi/v1/capital/deposit/hisrec, for each new tx_hash not in deposits, insert. Once confirmations ≥ threshold (TRC20 = 1), flip to credited, create investment, credit nothing yet (day 1 fires tomorrow), queue WhatsApp "deposit received".
Daily 00:05 UTC: runDailyEarningsCredit() — for each investments WHERE status='active' AND today BETWEEN start_date AND end_date, insert earnings_ledger row (ON CONFLICT DO NOTHING), credit profile balance, write audit, queue WhatsApp "+$X earned today, balance $Y". When days_credited hits 20 → status=completed.
Every 30s: WhatsApp service polls whatsapp_outbox WHERE status='queued' (or main app pushes via signed webhook to the service).
Every 30s: signer worker polls withdrawals WHERE status='approved' (or webhook push).
7. BINANCE INTEGRATION RULES
Two API keys, with DIFFERENT permissions:
BINANCE_READ_KEY / BINANCE_READ_SECRET — Read-only + Enable Spot & Margin Trading OFF + Enable Withdrawals OFF. Lives on main app. Used to poll deposit history and fetch deposit addresses.
BINANCE_WITHDRAW_KEY / BINANCE_WITHDRAW_SECRET — Enable Withdrawals ON, IP-whitelisted to the signer's static IP only, withdrawal address whitelist enabled on Binance account. Lives ONLY on the signer worker host. NEVER in the main app.
All requests HMAC-SHA256 signed per Binance spec. Always include timestamp and recvWindow=5000.
Rate-limit aware: respect X-MBX-USED-WEIGHT-1M. Back off on 429/418.
Deposit detection: GET /sapi/v1/capital/deposit/hisrec?coin=USDT&status=1 (1 = success). Dedupe by txId.
Withdrawal submission (signer only): POST /sapi/v1/capital/withdraw/apply with coin=USDT, network=TRC20, address, amount, withdrawOrderId={withdrawals.id} (Binance dedupes on this).
8. WHATSAPP SERVICE CONTRACT (SEPARATE REPO — full spec for the other AI)
8.1 Purpose
Send templated WhatsApp messages reliably. Nothing else. No business logic. No DB writes other than its own outbox cache + delivery receipts.

8.2 Stack
Node.js 20, TypeScript, Fastify.
Redis for dedupe + retry queue (BullMQ).
WhatsApp Cloud API (Meta).
Deployed on Railway (recommended) — needs a static outbound IP only if Meta restricts (it doesn't, but Binance signer does).
8.3 Required env vars
WA_PHONE_NUMBER_ID=...
WA_BUSINESS_ACCOUNT_ID=...
WA_ACCESS_TOKEN=...               # long-lived system user token
WA_VERIFY_TOKEN=...               # for Meta webhook subscription
MAIN_APP_BASE_URL=https://...     # the Lovable Cloud app
MAIN_APP_HMAC_SECRET=...          # shared with main app, used to sign callbacks
INBOUND_HMAC_SECRET=...           # main app signs pushes to us with this
REDIS_URL=...
PORT=8080
8.4 HTTP surface (the service exposes)
POST /v1/send — main app pushes a message. Body:
{ "idempotency_key": "...", "to": "+2547...", "template": "deposit_received",
  "variables": { "amount": "20.00", "balance": "20.00", "name": "Jane" } }
Headers: X-Signature: sha256=<hex hmac of raw body using INBOUND_HMAC_SECRET>, X-Timestamp: <unix>.
Reject if timestamp drift > 300s.
Response: 202 Accepted + queue ID. Idempotent on idempotency_key.
POST /v1/webhook/meta — Meta delivery receipts. Standard Meta verification flow.
GET /health.
8.5 Callbacks INTO main app
POST {MAIN_APP_BASE_URL}/api/public/whatsapp/delivery-receipt
Body: { "idempotency_key": "...", "status": "sent|delivered|read|failed", "error": "..." }
Signed with MAIN_APP_HMAC_SECRET.
8.6 Approved Meta templates (must be pre-approved in Meta Business Manager — list these for the user to submit)
otp_code — "Your {{1}} verification code is {{2}}. Expires in 5 minutes. Never share it."
deposit_received — "Hi {{1}}, we received your deposit of {{2}} USDT. Your investment of {{2}} starts earning tomorrow. Balance: {{3}} USDT."
daily_earning — "Hi {{1}}, you earned {{2}} USDT today (day {{3}} of 20 on your {{4}} USDT investment). Available balance: {{5}} USDT."
withdrawal_requested — "Hi {{1}}, withdrawal of {{2}} USDT to {{3}} is pending review. You'll be notified when sent."
withdrawal_sent — "Hi {{1}}, {{2}} USDT sent to {{3}}. Tx: {{4}}. Balance: {{5}} USDT."
withdrawal_failed — "Hi {{1}}, withdrawal of {{2}} USDT failed: {{3}}. Funds returned to your balance."
security_alert — "Hi {{1}}, a {{2}} was just performed on your account. If this wasn't you, freeze your account now: {{3}}."
8.7 Retry policy
Attempt 1 immediate, then 30s, 2min, 10min, 1h, 6h, then fail.
After fail, POST delivery-receipt with status=failed.
8.8 Security
ALL requests in/out HMAC-SHA256 signed.
Constant-time signature comparison (crypto.timingSafeEqual).
Reject requests with no X-Timestamp or drift > 5 min.
Log to stdout in JSON. Never log full tokens or full phone numbers (mask middle digits).
9. WITHDRAWAL SIGNER WORKER (SEPARATE PROCESS — full spec)
9.1 Purpose
Pull approved withdrawals from main app, submit to Binance, report result. Nothing else.

9.2 Env vars
BINANCE_WITHDRAW_KEY=...
BINANCE_WITHDRAW_SECRET=...
MAIN_APP_BASE_URL=...
MAIN_APP_HMAC_SECRET=...
POLL_INTERVAL_SECONDS=30
9.3 Loop
GET {MAIN_APP}/api/public/signer/pull-approved (HMAC auth) → list of approved withdrawals (id, amount, address, network).
For each: call Binance withdraw/apply with withdrawOrderId=withdrawal.id (Binance idempotency).
POST {MAIN_APP}/api/public/signer/withdrawal-result with {id, binance_withdrawal_id, status, error?}.
Main app updates row, queues WhatsApp message.
9.4 Safety
Hard cap: refuse to submit > 1000 USDT in a single tx without manual flag.
Hard cap: refuse > 5000 USDT/hour total.
If Binance returns address-not-whitelisted, mark withdrawal failed and surface for admin.
10. SECURITY CHECKLIST (the builder MUST satisfy all)
 RLS on every table. Default deny. Explicit auth.uid() = user_id policies for user rows.
 has_role() SECURITY DEFINER for admin checks. Never check role from client.
 Passwords: Supabase Auth handles (Argon2). Never roll your own.
 OTPs: 6 digits, cryptographically random, bcrypt-hashed in DB.
 Rate limits (in code, not infra): 5 OTP requests / 15 min / user; 10 withdrawal attempts / day / user.
 HMAC on every cross-service call. timingSafeEqual for comparison.
 CSP header, X-Frame-Options: DENY, Strict-Transport-Security (handled by Lovable Cloud + add explicit in __root.tsx head).
 Withdrawal address: simple regex sanity (^T[1-9A-HJ-NP-Za-km-z]{33}$ for TRC20) AND must be confirmed by OTP every time (no "saved addresses" in v1).
 2FA TOTP mandatory for admin role.
 No PII in logs. Mask +254****1234.
 Audit table is append-only (revoke UPDATE/DELETE from all roles).
 Backup: daily logical dump of Postgres, retain 30 days.
11. FRONTEND PAGES (only these — no more)
/ — landing (explain product, CTA to signup). SEO meta required.
/auth — login + signup tabs.
/onboarding/whatsapp — set + verify WhatsApp number (gated).
/_authenticated/dashboard — balance, active investments (with day X/20 progress bar), recent activity.
/_authenticated/deposit — show TRC20 address + QR code + minimum, with "checking…" indicator.
/_authenticated/withdraw — form (amount, address, OTP), shows fee preview.
/_authenticated/history — tabs: deposits / earnings / withdrawals.
/_authenticated/settings — change WhatsApp, change password (both OTP-gated).
/_authenticated/admin — admin-only (has_role check in loader AND on every action): pending withdrawals queue, user search, balance adjustments, audit viewer.
Design: pick ONE strong direction (dark fintech, glassmorphism, accent oklch). Use semantic tokens. No purple-on-white default AI look.

12. PHASED DELIVERY PLAN — HAND TO THE OTHER AI ONE PHASE AT A TIME
Rule for the receiving AI: complete a phase fully, run lint + typecheck, present what was built, WAIT for explicit approval before the next phase. Do not skip ahead.

PHASE 1 — Foundation & Auth (no money logic yet)
Deliverables:

Project scaffold per §4.
All tables in §5 created via ONE migration. RLS + grants + has_role() + audit triggers.
Supabase Auth (email/password) wired.
Profile auto-creation trigger.
Landing page, /auth, /_authenticated/dashboard (empty shell showing 0 balance).
Admin role seeding doc (manual SQL the user runs once).
CI: build, typecheck, lint, basic vitest.
Exit criteria: a user can sign up, log in, see empty dashboard. Admin can be promoted via SQL.

PHASE 2 — WhatsApp OTP plumbing (no Binance yet)
Deliverables:

whatsapp_outbox + otps tables in use.
requestOtp / verifyOtp server fns.
/onboarding/whatsapp flow with OTP verify.
/api/public/whatsapp/delivery-receipt route with HMAC.
Separate repo: WhatsApp service per §8 (mock mode: writes to console instead of Meta for dev). Provide README with Railway deploy steps and Meta template submission guide.
E2E test: signup → set number → receive (mocked) OTP → verify.
Exit criteria: OTP round-trip works end-to-end against mock WhatsApp service, then against real Meta sandbox.

PHASE 3 — Binance deposit detection + investments
Deliverables:

deposits + investments + binance_deposit_addresses + earnings_ledger tables active.
Binance read-only client (server-only file).
getDepositAddress server fn (calls Binance, caches).
/_authenticated/deposit page with QR.
pollBinanceDeposits cron (every 2 min) — creates deposit row, on confirm creates investment, queues WhatsApp deposit_received.
Daily earnings cron — credits ledger + balance + audit + queues WhatsApp daily_earning. Idempotent.
/_authenticated/history deposits + earnings tabs.
Test: simulate a Binance webhook payload, verify full flow (use a fixture, not real money).
Exit criteria: on testnet or with a tiny real deposit, the platform detects it, creates the investment, and pays day-1 the next UTC midnight.

PHASE 4 — Withdrawals (queued, admin-approved, signer worker)
Deliverables:

withdrawals table active with OTP requirement.
/_authenticated/withdraw page.
requestWithdrawal server fn (debits balance immediately, status=pending).
Admin page: pending queue + approve/reject (requires admin 2FA).
/api/public/signer/pull-approved + /api/public/signer/withdrawal-result routes.
Separate repo (or merged with WhatsApp service): signer worker per §9.
On failure: re-credit balance + audit + WhatsApp withdrawal_failed.
Exit criteria: full withdrawal cycle works against Binance testnet. Approved → broadcast → confirmed → user notified.

PHASE 5 — Hardening, observability, admin tools
Deliverables:

Rate limits implemented.
Audit viewer page.
Balance reconciliation tool: nightly job that sums transaction_audit per user and compares to profiles.available_balance_micro. Discrepancy → freeze user + alert admin.
Error reporting (Sentry or built-in).
Backup verification doc.
Runbook for: stuck deposit, stuck withdrawal, leaked key rotation, WhatsApp service down.
Exit criteria: chaos test passes — kill WhatsApp service mid-OTP, kill signer mid-withdrawal, retry, everything reconciles.

PHASE 6 — Launch checklist
Pen-test self-check using the checklist in §10.
Legal: ToS, Privacy Policy, risk disclosure (THIS IS HIGH-RISK CONTENT — 200% returns are characteristic of HYIPs/Ponzi schemes; the user MUST seek legal counsel and disclose risk to users. The builder must add a visible risk disclaimer on signup.).
Real-money smoke test: $10 deposit, observe 20 days, $2 withdraw.
Publish.
13. WHAT THE OTHER AI MUST ASK BEFORE PHASE 1
Even with this doc, these are project-specific and the builder must confirm:

Confirm currency = USDT TRC20 only (yes/no).
Confirm 10% × 20 days = 200% total, principal NOT separately returned (yes/no).
Provide Meta WhatsApp Business Account ID + Phone Number ID + access token (or confirm using mock in dev).
Provide Binance account email; confirm two API keys will be created with the permissions in §7.
Choose WhatsApp service host: Railway / Fly / Render / VPS.
Choose signer worker host (must have static IP for Binance whitelist).
Provide admin email(s) for initial role seeding.
Confirm legal disclosure language has been reviewed by a lawyer.
If any answer is "I don't know" — STOP, escalate to the human. Do not proceed.

14. GLOSSARY (for the receiving AI)
micro-USDT: integer = USDT × 1_000_000. All math uses this.
Idempotency key: a string that, if seen twice, results in zero additional side effects.
Investment: the 20-day earning contract created from a single deposit.
Available balance: what the user can withdraw right now.
Locked principal: not used in this model — all earnings are paid into available balance daily.
END OF SPEC v1. If the receiving AI completes a build that contradicts any section above, the build is rejected and rebuilt from this document.
