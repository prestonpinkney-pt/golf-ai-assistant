import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("server-only is a direct production dependency", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(typeof pkg.dependencies?.["server-only"], "string");
});

test("Vercel Square crons have reachable handlers", () => {
  const revenueCron = read("app/api/cron/square-revenue-sync/route.ts");
  assert.match(revenueCron, /export async function GET\(/);

  const directoryRoute = read(
    "app/api/integrations/square/sync-customer-directory/route.ts"
  );
  assert.match(directoryRoute, /syncSquareCustomerDirectory/);
  assert.match(directoryRoute, /export async function POST\(/);
});

test("dashboard conversation access fails closed", () => {
  const tenantGuard = read("lib/conversations/conversation-tenant.ts");
  assert.match(tenantGuard, /return rowBiz != null && rowBiz === businessId/);

  const aiRespond = read("app/api/ai/respond/route.ts");
  assert.match(aiRespond, /dashboardBusinessId/);
  assert.match(aiRespond, /conversationAccessibleToBusiness/);
});

test("failed Sent.dm jobs remain retryable and fail provider acknowledgement", () => {
  const handler = read("lib/sentdm/handle-webhook-post.ts");
  const failedBranch = handler.slice(
    handler.indexOf('if (processResult.jobStatus === "failed")'),
    handler.indexOf('status: "processed"')
  );
  assert.match(failedBranch, /\{ status: 503 \}/);

  const migration = read(
    "supabase/migrations/20260717110000_webhook_jobs_reliability_security.sql"
  );
  assert.match(migration, /function public\.begin_webhook_job/);
  assert.match(migration, /j\.status = 'failed'/);
  assert.match(migration, /j\.attempts < 5/);
  assert.match(
    migration,
    /revoke all on table public\.webhook_jobs from public, anon, authenticated/
  );
});
