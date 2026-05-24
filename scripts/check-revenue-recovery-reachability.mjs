/**
 * Diagnostics: Square + Revenue Recovery reachability.
 *
 * Usage: npx tsx scripts/check-revenue-recovery-reachability.mjs
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
      console.warn("[check-revenue-recovery-reachability] Could not load env files.");
    }
  }
}

loadEnv();

const businessId =
  process.env.CLOSEOS_BUSINESS_ID?.trim() ||
  process.env.BUSINESS_ID?.trim() ||
  null;

const { createClient } = await import("@supabase/supabase-js");
const { computeReachabilityReport } = await import(
  "../lib/revenue-recovery/reachability.ts"
);
const { resolveSquareSyncLookbackDays } = await import(
  "../lib/revenue-recovery/segments.ts"
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const lookbackDays = resolveSquareSyncLookbackDays();
const lookbackStart = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

let query = supabase
  .from("customer_profiles")
  .select(
    "id, source, first_name, last_name, email, phone, total_spend_cents, last_purchase_at, raw_payload, exclude_from_ai_targeting"
  )
  .eq("source", "square");

if (businessId) {
  query = query.eq("business_id", businessId);
}

const { data: rows, error } = await query;

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

const phones = new Set();
for (const row of rows ?? []) {
  const p = row.phone?.trim();
  if (p) phones.add(p);
}

const optOutByPhone = new Map();
if (phones.size > 0) {
  const { data: contacts } = await supabase
    .from("contacts")
    .select("phone, sms_opt_out")
    .in("phone", Array.from(phones));

  for (const c of contacts ?? []) {
    if (c.phone) optOutByPhone.set(c.phone, Boolean(c.sms_opt_out));
  }
}

const profiles = (rows ?? []).map((row) => ({
  ...row,
  sms_opt_out: row.phone ? Boolean(optOutByPhone.get(row.phone)) : false,
  campaign_status: "not_contacted",
}));

const report = computeReachabilityReport(profiles);

let purchaseQuery = supabase
  .from("purchase_history")
  .select("external_payment_id, external_order_id, customer_profile_id", { count: "exact" })
  .eq("source", "square")
  .gte("occurred_at", lookbackStart);

if (businessId) {
  purchaseQuery = purchaseQuery.eq("business_id", businessId);
}

const { data: purchaseRows, count: purchaseRowsCount } = await purchaseQuery;
const orderIds = new Set();
let unlinkedPurchaseRows = 0;
for (const row of purchaseRows ?? []) {
  if (row.external_order_id) orderIds.add(row.external_order_id);
  if (!row.customer_profile_id) unlinkedPurchaseRows += 1;
}

console.log("Revenue Recovery reachability");
console.log(
  JSON.stringify(
    {
      businessId: businessId ?? "(all businesses)",
      square_sync_lookback_days: lookbackDays,
      square_profiles_total: report.squareProfilesTotal,
      square_customers_fetched_total: report.squareProfilesTotal,
      payments_fetched_total: purchaseRowsCount ?? 0,
      orders_fetched_total: orderIds.size,
      purchase_rows_upserted: purchaseRowsCount ?? 0,
      square_130plus_2yr_total: report.square130PlusTotal,
      square_130plus_2yr_with_phone: report.square130PlusWithPhone,
      square_130plus_2yr_with_email: report.square130PlusWithEmail,
      square_130plus_2yr_reachable: report.square130PlusReachable,
      square_130plus_2yr_missing_contact_info: report.square130PlusMissingContactInfo,
      recently_active_upsell_count: report.recentlyActiveUpsellCount,
      recently_active_upsell_textable: report.recentlyActiveUpsellTextableCount,
      warm_inactive_count: report.revenueRecoveryWarmInactiveCount,
      warm_inactive_textable:
        report.revenueRecoveryWarmInactiveTextableCount,
      cold_high_value_count: report.coldHighValueCount,
      cold_high_value_textable: report.coldHighValueTextableCount,
      missing_identity_count: report.revenueRecoveryMissingIdentityCount,
      skipped_not_found: null,
      unlinked_purchase_rows: unlinkedPurchaseRows,
    },
    null,
    2
  )
);
