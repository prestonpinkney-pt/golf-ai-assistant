# CloseOS / Golf AI Assistant — multi-agent functionalization prompt

Copy the **Master prompt** below into a new Cloud Agent (or split into the **Workstream prompts** for parallel agents). Goal: make the app **buildable, test-green, env-verifiable, and operable end-to-end** for a single tenant (Primetime Golf) per [closeos-operator-runbook.md](./closeos-operator-runbook.md).

---

## Master prompt (orchestrator)

You are fixing **golf-ai-assistant** (Next.js 16 CloseOS stack): inbound SMS (Sent.dm), Supabase persistence, Square customer/revenue sync, dashboard, and revenue recovery.

### Definition of “functional”

1. **`npm run build`** succeeds with **no** Supabase env vars set at build time (Vercel pattern).
2. **`npm run test:ci`** passes (currently 1 failing test in webhook suite).
3. **`npm run typecheck`** passes (already green).
4. **`npm run lint`** passes or CI is updated to fail on lint (today `continue-on-error: true` in `.github/workflows/closeos-ci.yml`).
5. Ops scripts work when `.env.local` is populated:
   - `npm run verify:messaging-env` (without `VERIFY_MESSAGING_ENV_CI=1`)
   - `npm run sync:square-customers`
   - `npm run check:revenue-recovery`
6. Core runtime path works: Sent.dm webhook → `webhook_jobs` → cron drain → inbound event → contact/conversation/message → AI respond → outbound send (with guards: opt-out, cooling-off, quiet hours).
7. No **P0** items from `CLOSESOS_BUILD_TRACKER.md` “Reliability + Maintainability” left unaddressed for paths you touch (hardcoded tenant IDs in API routes, JSON file persistence, module-level Supabase clients).

### Known bugs (verify and fix)

| ID | Symptom | Likely cause | Files to inspect |
|----|---------|--------------|------------------|
| B1 | `next build` fails: `supabaseUrl is required` on `/opportunities/targets` | Importing `@/lib/supabase/admin` runs **module-level** `createClient("", "")` on `supabaseAdmin` | `lib/supabase/admin.ts`, anything importing it (e.g. `app/api/lib/require-auth.ts`) |
| B2 | `test:webhook` fails: `sentDmWebhookSignatureHeaderPresence` expects `x-sentdm-timestamp: true`, gets `undefined` | Diagnostic helper omits `x-sentdm-timestamp` / `x-sent-dm-timestamp` while HMAC path reads them | `lib/messaging/sentdm-webhook.ts`, `lib/sentdm/webhook-queue.test.ts` |
| B3 | `verify:messaging-env` fails locally without secrets | Expected; add **`.env.example`** (no secrets) documenting required vars from runbook | `docs/closeos-operator-runbook.md`, `scripts/verify-messaging-env.mjs` |
| B4 | Runbook says webhook cron **every 5 minutes**; `vercel.json` schedules `process-webhook-jobs` **once daily** (`0 8 * * *`) | Doc/config drift | `vercel.json`, `docs/closeos-operator-runbook.md` |
| B5 | `lint:hardcoded` flags hardcoded domain | `app/api/config/ai-source-of-truth.ts` | Align with `getBusinessConfig()` / env overrides |
| B6 | Several API routes use **top-level** `createClient(process.env...!)` | Build-time or missing-env crashes | `app/api/inbound/route.ts`, `app/api/ai/respond/route.ts`, etc. — lazy-init inside handlers |
| B7 | Deprecated `supabaseAdmin` singleton still used | Leads API cluster | `app/api/leads/**` → migrate to `createSupabaseServiceRoleClient()` |

### Execution rules

- Read **`docs/closeos-operator-runbook.md`** and **`CLOSESOS_BUILD_TRACKER.md`** before large refactors.
- **Minimize scope**: one workstream per agent; small PRs.
- **Do not commit secrets**. Add `.env.example` with empty placeholders only.
- After code changes: `npm run typecheck`, `npm run test:ci`, `npm run build` (env vars unset unless testing lazy-init).
- Branch naming (Cloud Agents): `cursor/<descriptive-name>-7d21`.

### Suggested workstreams (parallel)

Assign one agent per section; orchestrator merges and resolves conflicts in `lib/supabase/admin.ts` first (blocks build).

---

## Workstream A — Build & Supabase client lifecycle (P0)

**Prompt:**

> Fix production `next build` without requiring `NEXT_PUBLIC_SUPABASE_URL` at compile/collect-page-data time.
>
> 1. Remove or lazy-initialize `export const supabaseAdmin` in `lib/supabase/admin.ts` so importing `createSupabaseServiceRoleClient` does not call `createClient` with empty strings.
> 2. Replace module-level `const supabase = createClient(...)` in API routes with lazy factories (pattern already used in `app/api/opportunities/targets/route.ts` `getSupabaseAdmin()`).
> 3. Migrate `app/api/leads/**` off deprecated `supabaseAdmin`.
> 4. Run `npm run build` with **no** Supabase env vars; must succeed.
>
> **Done when:** `npm run build` passes in a clean shell; grep shows no top-level `createClient` in `app/api` except inside functions.

---

## Workstream B — Sent.dm webhooks & messaging (P0)

**Prompt:**

> Make Sent.dm webhook handling consistent and tests green.
>
> 1. Fix `sentDmWebhookSignatureHeaderPresence` to include all timestamp/signature header aliases used by `parseWebhookTimestampSeconds` and tests (`x-sentdm-timestamp`, `x-sent-dm-timestamp`, etc.).
> 2. Run `npm run test:webhook` and `npm run test:sentdm`; all pass.
> 3. Confirm `app/api/sentdm/webhook/route.ts` and legacy `app/api/webhooks/sent` stay in parity.
> 4. Optional: add regression test if header list changes again.
>
> **Done when:** `npm run test:ci` has zero failures.

---

## Workstream C — Environment & operator UX (P1)

**Prompt:**

> Improve local/operator setup without committing secrets.
>
> 1. Add `.env.example` listing every variable from `docs/closeos-operator-runbook.md` with short comments.
> 2. Ensure `scripts/verify-messaging-env.mjs`, `sync-square-customers.mjs`, and `check-revenue-recovery-reachability.mjs` load env via `@next/env` (works after `npm install`; no silent fallback when dotenv is absent).
> 3. Document in README: copy `.env.example` → `.env.local`, then run the three ops scripts.
>
> **Done when:** new clone + `.env.local` from example + real secrets → three ops scripts exit 0.

---

## Workstream D — Cron, revenue recovery, Square sync (P1)

**Prompt:**

> Align scheduled jobs with operator docs and prove revenue recovery path.
>
> 1. Reconcile `vercel.json` cron schedules with `docs/closeos-operator-runbook.md` (especially `process-webhook-jobs` frequency).
> 2. Trace `/api/cron/square-customer-directory`, `square-revenue-sync`, and `process-webhook-jobs` auth (`CRON_SECRET`) and error responses.
> 3. Run `npm run test:revenue-recovery`; fix any failures.
> 4. Manually trace `scripts/sync-square-customers.mjs` and `scripts/check-revenue-recovery-reachability.mjs` error messages for missing env (clear, actionable).
>
> **Done when:** cron paths documented match `vercel.json`; revenue recovery tests pass.

---

## Workstream E — CI, lint, hardcoded tenant values (P2)

**Prompt:**

> Harden CI and reduce single-tenant footguns.
>
> 1. Fix ESLint errors (33 errors today; many in app/components and `tests/stub-server-only.cjs` — use overrides or fix as appropriate).
> 2. Decide: set `continue-on-error: false` on lint in `.github/workflows/closeos-ci.yml` once clean.
> 3. Run `npm run lint:hardcoded`; fix `app/api/config/ai-source-of-truth.ts` to use `getBusinessConfig()` / env.
> 4. Progress `CLOSESOS_BUILD_TRACKER.md` P0 items for `app/api/**` hardcoded business IDs (use `app/api/config/index.ts`).
>
> **Done when:** `npm run lint` exits 0 (or documented eslint ignore only for intentional CJS stubs); `lint:hardcoded` exits 0.

---

## Workstream F — Smoke / E2E validation (after A+B)

**Prompt:**

> Prove the conversational path in dev (no production SMS unless allowlisted).
>
> 1. With dev server: `npm run test:sentdm-webhook:signed` (needs `SENTDM_WEBHOOK_SECRET`, `SENTDM_API_KEY` in `.env.local`).
> 2. `npm run drain:sentdm-webhook-jobs` if jobs stick.
> 3. Document minimal smoke checklist in runbook: one inbound webhook → row in `inbound_events` / `messages` → job completed.
> 4. Use `CLOSEOS_LIVE_AGENT_TEST_MODE` + allowlist only for explicit live tests per runbook.
>
> **Done when:** signed webhook integration test passes locally; checklist added to runbook.

---

## Orchestrator checklist (final merge)

```bash
npm ci
npm run typecheck
npm run test:ci
npm run lint:hardcoded
npm run build    # no Supabase env in shell
```

If the user provides production secrets in the Cloud Agent environment, also run:

```bash
npm run verify:messaging-env
npm run sync:square-customers
npm run check:revenue-recovery
```

Report: PR links per workstream, remaining risks, and any env vars the human must set in Vercel.
