import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const key = t.slice(0, eq).trim();
  let val = t.slice(eq + 1).trim();
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    val = val.slice(1, -1);
  }
  if (!process.env[key]) process.env[key] = val;
}

const biz = process.env.CLOSEOS_BUSINESS_ID;
const { createSupabaseServiceRoleClient } = await import("../lib/supabase/admin.ts");
const { loadWhooshAvailabilityWindows } = await import(
  "../lib/whoosh/load-availability-windows.ts"
);
const { truthFieldsForDb } = await import("../app/api/lib/closeos-opportunity-truth.ts");

const supabase = createSupabaseServiceRoleClient();
const windows = await loadWhooshAvailabilityWindows({
  supabase,
  businessId: biz,
  startDate: "2026-05-24",
  endDate: "2026-06-03",
  resourceType: "simulator",
});

const { data: profiles } = await supabase
  .from("customer_profiles")
  .select("id, phone")
  .eq("exclude_from_ai_targeting", false)
  .not("phone", "is", null)
  .limit(3);

const profile = profiles?.[0];
const recognized = "simulator_open_bay_fill";
const truth = truthFieldsForDb(recognized);
const metadata = {
  availability_source: "whoosh",
  availability_verified: true,
  whoosh_window_ids: windows.slice(0, 3).map((w) => w.id),
  window_count: windows.length,
  suggested_dayparts: ["general"],
};

const payload = {
  business_id: biz,
  customer_profile_id: profile?.id,
  recognized_opportunity: recognized,
  opportunity_type: "slow_time",
  playbook: "simulator-open-bay-fill",
  status: "open",
  priority: 75,
  confidence: 82,
  estimated_revenue_cents: truth.estimated_revenue_cents ?? 4500,
  revenue_review_required: truth.revenue_review_required ?? false,
  counts_toward_pipeline: truth.counts_toward_pipeline ?? true,
  pipeline_category: truth.pipeline_category ?? "known_pipeline",
  offer_key: truth.offer_key ?? null,
  source: "whoosh_availability",
  signal_summary: "QA probe refresh path",
  next_best_action: "Review",
  reply_handling_goal: "Book",
  recommended_message: null,
  metadata,
  updated_at: new Date().toISOString(),
};

const { error: insErr, data: insData } = await supabase
  .from("ai_opportunities")
  .insert(payload)
  .select("id")
  .single();

console.log(
  JSON.stringify(
    {
      windows: windows.length,
      profileId: profile?.id,
      truth,
      insertError: insErr?.message ?? null,
      insertCode: insErr?.code ?? null,
      insertDetails: insErr?.details ?? null,
      insertedId: insData?.id ?? null,
    },
    null,
    2
  )
);

if (insData?.id) {
  await supabase.from("ai_opportunities").delete().eq("id", insData.id);
}
