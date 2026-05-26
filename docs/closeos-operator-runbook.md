# CloseOS operator runbook — Primetime Golf (production)

Step-by-step onboarding for a fresh production deploy. **Never commit secrets** — use Vercel env vars and local `.env.local` only.

---

## 1. Supabase migrations

Apply every file under `supabase/migrations/` in **timestamp order** (oldest first).

```bash
# One-time: link CLI to the production project
npx supabase link --project-ref <YOUR_SUPABASE_PROJECT_REF>

# Apply pending migrations to the linked remote database
npx supabase db push
```

Core tables this stack expects (do not rename): `contacts`, `leads`, `conversations`, `messages`, `inbound_events`, `audit_logs`, `qualification_profiles`, plus CloseOS extensions (`businesses`, `business_messaging_configs`, `campaigns`, `webhook_jobs`, `customer_profiles`, etc.).

After push, confirm in Supabase SQL editor that `messages`, `conversations`, and `webhook_jobs` exist.

---

## 2. Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (Production). Use placeholders locally in `.env.local` — never paste real keys into git.

| Variable | Purpose |
| -------- | ------- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase (keep secret) |
| `OPENAI_API_KEY` | AI reply drafting |
| `CLOSEOS_BUSINESS_ID` | UUID for Primetime Golf tenant row |
| `SENTDM_API_KEY` (or `SENT_API_KEY` / `SENT_DM_API_KEY`) | Sent.dm outbound |
| `SENTDM_WEBHOOK_SECRET` | HMAC signing secret for inbound Sent.dm webhooks (required when secret is set) |
| `SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS` | **Development only.** `true` allows unsigned smoke tests (not integration) |
| `SENTDM_REQUIRE_SIGNED_DEV_WEBHOOKS` | **Development only.** `true` always rejects unsigned (redundant when secret is set) |
| `SENT_DM_TEMPLATE_ID` | Required when `SENTDM_SEND_MODE=template` (default) |
| `SQUARE_ACCESS_TOKEN` | Square API (sync scripts + revenue) |
| `SQUARE_LOCATION_ID` | Square location for payments/sync |
| `SQUARE_ENVIRONMENT` | `production` or `sandbox` |
| `CRON_SECRET` | Vercel Cron auth (`Authorization: Bearer …`) |

Optional but common:

| Variable | Purpose |
| -------- | ------- |
| `CLOSEOS_TEST_SMS_ALLOWLIST` | Comma-separated E.164; required for live agent test mode provider auto-send |
| `CLOSEOS_LIVE_AGENT_TEST_MODE` | `true` enables allowlisted inbound auto-send QA (does not bypass STOP/opt-out/cooling-off/high-risk) |
| `CLOSEOS_QUIET_HOURS_ENABLED` | `true` to defer overnight sends |
| `CLOSEOS_WEBHOOK_JOB_SECRET` | Ops override for manual webhook drain |
| `WHOOSH_*` | Whoosh agenda/booking integration (if enabled) |

Verify messaging env **without printing secrets**:

```bash
npm run verify:messaging-env
```

CI uses `VERIFY_MESSAGING_ENV_CI=1` to skip secret requirements; production must pass without that flag.

---

## 3. First Square sync

Import Square customers into `customer_profiles` for Revenue Recovery targeting:

```bash
# Requires CLOSEOS_BUSINESS_ID, Supabase service role, SQUARE_ACCESS_TOKEN
npm run sync:square-customers
```

Check reachability counts (phones, opt-outs, high-value segments):

```bash
npm run check:revenue-recovery
```

Output is JSON diagnostics only — no raw tokens.

Vercel Cron also runs scheduled syncs (see `vercel.json`):

- `/api/cron/square-customer-directory` — daily 06:00 UTC
- `/api/cron/square-revenue-sync` — every 6 hours

Manual full sync (customers + payments) when debugging:

```bash
npx tsx scripts/sync-square-all.mjs
```

---

## 4. Sent.dm webhook URL

In the Sent.dm dashboard, point inbound message webhooks to your **production** host:

| Route | Notes |
| ----- | ----- |
| `https://<your-domain>/api/sentdm/webhook` | **Primary** — use this for new setups |
| `https://<your-domain>/api/webhooks/sent` | Legacy alias (same handler) |

Requirements:

1. Set `SENTDM_WEBHOOK_SECRET` in Vercel to match Sent.dm signing secret.
2. In production, unsigned webhooks are always rejected — no dev bypass flags apply.
3. Do **not** embed API keys in webhook URLs.
4. Confirm Vercel Cron drains the queue: `/api/cron/process-webhook-jobs` every 5 minutes (needs `CRON_SECRET`).

### Local webhook testing

| Mode | Env | Command |
| ---- | --- | ------- |
| **Integration (recommended)** | `SENTDM_WEBHOOK_SECRET` + `SENTDM_API_KEY` | `npm run test:sentdm-webhook:signed` |
| **Unsigned smoke only** | `SENTDM_ALLOW_UNSIGNED_DEV_WEBHOOKS=true` | `npm run test:sentdm-webhook:smoke` |

Signed `message.received` with `payload.message_id` runs HMAC verification (`verificationMode: hmac_sha256_body`), GET `/v3/messages/{id}`, and returns HTTP 200 with `status: "processed"`, `message_id`, and `contactId`. Unsigned text-only fixtures log `mode: local_text_envelope` and queue without Sent.dm lookup — smoke only.

**Sent.dm dashboard:** configure webhook URL to `https://<host>/api/sentdm/webhook`, paste the same value into `SENTDM_WEBHOOK_SECRET`, and send a real inbound SMS. Confirm the JSON response includes `"status":"processed"`.

### Live conversational agent test (allowlisted phone)

Set in `.env.local`:

```bash
CLOSEOS_LIVE_AGENT_TEST_MODE=true
CLOSEOS_TEST_SMS_ALLOWLIST=+15103756639
CLOSEOS_AUTO_SEND_ENABLED=true
```

Commands:

| Step | Command |
| ---- | ------- |
| Unit + mocked full path | `npm run test:live-agent-sms` |
| Debug latest reply state | `npm run qa:live-agent-reply -- --prepare` |
| Real E2E (dev server running) | `npm run test:live-agent-sms:e2e` |
| Drain stuck jobs | `npm run drain:sentdm-webhook-jobs` |

If send is skipped, check `provider_send_blocker` on the outbound message metadata or `npm run qa:live-agent-reply`.

Smoke test: send a test SMS to your Primetime number; confirm a row appears in `inbound_events` / `messages` and the cron job moves `webhook_jobs` to `completed`.

---

## 5. npm scripts (ops quick reference)

| Script | Command |
| ------ | ------- |
| Messaging env check | `npm run verify:messaging-env` |
| Square customer directory | `npm run sync:square-customers` |
| Revenue Recovery reachability | `npm run check:revenue-recovery` |
| Full test bundle (CI) | `npm run test:ci` |
| Typecheck | `npm run typecheck` |

---

## 6. Operator UI checklist

1. Log into dashboard → **Settings** (`/settings`) — confirm sender number and webhook paths.
2. **Outbound / Campaigns** — drafts require explicit operator approval before send (no auto-blast).
3. **Messages** — human takeover stops unattended auto-send per messaging policy.
4. Review [CloseOS automation policy](./closeos-automation-policy.md): aggressive opportunity detection, disciplined customer contact.

---

## 7. Pre-launch verification

```bash
npm run typecheck
npm run test:ci
npm run verify:messaging-env
npm run sync:square-customers
npm run check:revenue-recovery
```

Deploy to Vercel, promote to production, then run one inbound SMS test and one approved outbound campaign test to a number on `CLOSEOS_TEST_SMS_ALLOWLIST` if the allowlist is enabled.
