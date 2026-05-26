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
const { loadOutboundOpportunityTargets } = await import(
  "../app/api/lib/opportunity-eligible-targets.ts"
);
const { filterTargetsByCampaignFocus } = await import(
  "../lib/campaigns/campaign-focus.ts"
);
const { refreshWhooshSlowTimeOpportunities } = await import(
  "../lib/whoosh/slow-time-opportunities.ts"
);

const supabase = createSupabaseServiceRoleClient();

const { count: winCount } = await supabase
  .from("whoosh_availability_windows")
  .select("*", { count: "exact", head: true })
  .eq("business_id", biz)
  .eq("bookable", true);

const { data: profiles, error: pErr } = await supabase
  .from("customer_profiles")
  .select("id, phone, exclude_from_ai_targeting")
  .not("phone", "is", null)
  .eq("exclude_from_ai_targeting", false)
  .limit(5);

const { data: whooshOpps } = await supabase
  .from("ai_opportunities")
  .select("id, source, recognized_opportunity, status, metadata")
  .eq("business_id", biz)
  .eq("source", "whoosh_availability")
  .limit(5);

const refresh = await refreshWhooshSlowTimeOpportunities({
  supabase,
  businessId: biz,
  startDate: "2026-05-24",
  endDate: "2026-06-03",
});

const profile = profiles?.[0];
let insertProbe = null;
if (profile) {
  const { error: insErr } = await supabase.from("ai_opportunities").insert({
    business_id: biz,
    customer_profile_id: profile.id,
    recognized_opportunity: "weekday_open_bay_fill",
    opportunity_type: "slow_time",
    playbook: "weekday-simulator-fill",
    status: "open",
    priority: 75,
    confidence: 82,
    estimated_revenue_cents: 4500,
    source: "whoosh_availability",
    signal_summary: "QA probe",
    metadata: {
      availability_source: "whoosh",
      availability_verified: true,
      whoosh_window_ids: ["probe"],
      window_count: 1,
      suggested_dayparts: ["weekday"],
    },
  });
  insertProbe = insErr?.message ?? "ok";
  if (!insErr) {
    await supabase
      .from("ai_opportunities")
      .delete()
      .eq("business_id", biz)
      .eq("source", "whoosh_availability")
      .eq("signal_summary", "QA probe");
  }
}

const { data: whooshOppsAfter } = await supabase
  .from("ai_opportunities")
  .select("id, source, recognized_opportunity, status, metadata")
  .eq("business_id", biz)
  .eq("source", "whoosh_availability")
  .in("status", ["open", "queued"])
  .limit(5);

const targets = await loadOutboundOpportunityTargets({ supabase, businessId: biz });
const slow = filterTargetsByCampaignFocus(targets, "slow_time");

console.log(
  JSON.stringify(
    {
      winCount,
      profileError: pErr?.message ?? null,
      profileCountSample: profiles?.length ?? 0,
      whooshOppsBefore: whooshOpps?.length ?? 0,
      refreshResult: refresh,
      insertProbe,
      whooshOppsAfterOpen: whooshOppsAfter?.length ?? 0,
      whooshOppAfterSample: whooshOppsAfter?.[0],
      totalTargets: targets.length,
      slowTargets: slow.length,
      slowSample: slow.slice(0, 2).map((t) => ({
        ro: t.recognizedOpportunity,
        verified: t.availabilityVerified,
        source: t.availabilitySource,
        phone: t.phone?.slice(-4),
      })),
    },
    null,
    2
  )
);
