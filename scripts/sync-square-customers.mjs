/**
 * Sync Square Customer Directory into customer_profiles for Revenue Recovery.
 *
 * Usage: npx tsx scripts/sync-square-customers.mjs
 */

import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const root = process.cwd();

function loadEnv() {
  try {
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(root);
  } catch {
    try {
      const dotenv = require("dotenv");
      dotenv.config({ path: join(root, ".env.local") });
      dotenv.config({ path: join(root, ".env") });
    } catch {
      console.warn("[sync-square-customers] Could not load env files.");
    }
  }
}

loadEnv();

const businessId =
  process.env.CLOSEOS_BUSINESS_ID?.trim() ||
  process.env.BUSINESS_ID?.trim() ||
  null;

if (!businessId) {
  console.error("Set CLOSEOS_BUSINESS_ID (or BUSINESS_ID) in .env.local");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { syncSquareCustomerDirectory, countHighValueReachable } = await import(
  "../lib/square/customer-directory-sync.ts"
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const accessToken = process.env.SQUARE_ACCESS_TOKEN?.trim();

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

if (!accessToken) {
  console.error(
    "Missing SQUARE_ACCESS_TOKEN — add to .env.local or connect Square OAuth in the app"
  );
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const { data: beforeRows } = await supabase
  .from("customer_profiles")
  .select(
    "total_spend_cents, last_purchase_at, first_name, last_name, email, phone, raw_payload, source"
  )
  .eq("business_id", businessId)
  .eq("source", "square");

const highValueReachableBefore = countHighValueReachable(beforeRows ?? []);

const stats = await syncSquareCustomerDirectory({
  supabase,
  businessId,
  accessToken,
  environment: process.env.SQUARE_ENVIRONMENT,
});

const { data: afterRows } = await supabase
  .from("customer_profiles")
  .select(
    "total_spend_cents, last_purchase_at, first_name, last_name, email, phone, raw_payload, source"
  )
  .eq("business_id", businessId)
  .eq("source", "square");

const highValueReachableAfter = countHighValueReachable(afterRows ?? []);

console.log(
  JSON.stringify(
    {
      businessId,
      squareEnvironment: process.env.SQUARE_ENVIRONMENT ?? "production",
      fetched_customers: stats.fetchedCustomers,
      updated_profiles: stats.updatedProfiles,
      inserted_profiles: stats.insertedProfiles,
      enriched_with_phone: stats.enrichedWithPhone,
      enriched_with_email: stats.enrichedWithEmail,
      skipped_not_found: stats.skippedNotFound,
      skipped_no_external_customer_id: stats.skippedNoExternalCustomerId,
      failed_other_errors: stats.failedOtherErrors,
      fallback_fetched: stats.fallbackFetched,
      raw_payload_backfilled: stats.rawPayloadBackfilled,
      high_value_reachable_before: highValueReachableBefore,
      high_value_reachable_after: highValueReachableAfter,
    },
    null,
    2
  )
);
