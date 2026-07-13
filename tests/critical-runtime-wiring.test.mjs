import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readText(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("server-only is declared for production imports", () => {
  const pkg = JSON.parse(readText("package.json"));
  assert.equal(typeof pkg.dependencies?.["server-only"], "string");
});

test("Square customer directory cron target exists and revenue cron supports GET", () => {
  const revenueCron = readText("app/api/cron/square-revenue-sync/route.ts");
  const directoryRoute = readText(
    "app/api/integrations/square/sync-customer-directory/route.ts"
  );

  assert.match(revenueCron, /export async function GET/);
  assert.match(revenueCron, /export async function POST/);
  assert.match(directoryRoute, /syncSquareCustomerDirectory/);
});

test("webhook job migration includes single-job claim and failed retry", () => {
  const migration = readText(
    "supabase/migrations/20260524120000_webhook_jobs_reclaim_stale.sql"
  );

  assert.match(migration, /create or replace function public\.begin_webhook_job/);
  assert.match(migration, /j\.status = 'failed'/);
  assert.match(migration, /j\.attempts < 5/);
});
