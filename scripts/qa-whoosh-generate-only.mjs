import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const key = t.slice(0, eq).trim();
  let val = t.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const biz = process.env.CLOSEOS_BUSINESS_ID;
const QA_USER_ID = "00000000-0000-4000-8000-000000000001";

const { createSupabaseServiceRoleClient } = await import("../lib/supabase/admin.ts");
const { loadOutboundOpportunityTargets } = await import(
  "../app/api/lib/opportunity-eligible-targets.ts"
);
const { filterTargetsByCampaignFocus } = await import(
  "../lib/campaigns/campaign-focus.ts"
);
const { generateAiCampaignDraft } = await import(
  "../lib/campaigns/generate-campaign.ts"
);

const supabase = createSupabaseServiceRoleClient();

const { count: winCount } = await supabase
  .from("whoosh_availability_windows")
  .select("*", { count: "exact", head: true })
  .eq("business_id", biz)
  .eq("bookable", true);

const { count: oppCount } = await supabase
  .from("ai_opportunities")
  .select("*", { count: "exact", head: true })
  .eq("business_id", biz)
  .eq("source", "whoosh_availability")
  .in("status", ["open", "queued"]);

const allTargets = await loadOutboundOpportunityTargets({ supabase, businessId: biz });
const slowFiltered = filterTargetsByCampaignFocus(allTargets, "slow_time");

const gen = await generateAiCampaignDraft({
  supabase,
  businessId: biz,
  userId: QA_USER_ID,
  campaignFocus: "slow_time",
  maxTargets: 25,
  loadTargets: async () => slowFiltered,
});

if (!gen.ok) {
  console.log(JSON.stringify({ ok: false, error: gen.error ?? gen.reason, winCount, oppCount, slowTargets: slowFiltered.length }, null, 2));
  process.exit(1);
}

const { data: msgs } = await supabase
  .from("campaign_messages")
  .select("id, status, message_text")
  .eq("campaign_id", gen.campaign.id);

const genSource = readFileSync(resolve(process.cwd(), "lib/campaigns/generate-campaign.ts"), "utf8");
const noSms = !genSource.includes("sendMessage") && !genSource.includes("sendSentDmMessage");

const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
let outboundPageStatus = null;
try {
  const res = await fetch(`${appUrl}/outbound/${gen.campaign.id}`, { redirect: "manual" });
  outboundPageStatus = res.status;
} catch {
  outboundPageStatus = "dev-server-not-running";
}

console.log(
  JSON.stringify(
    {
      ok: true,
      whooshWindowsCached: winCount,
      slowTimeOpportunitiesOpen: oppCount,
      slowTargets: slowFiltered.length,
      campaignId: gen.campaign.id,
      campaignStatus: gen.campaign.status,
      campaignSource: gen.campaign.source,
      campaignMessagesDrafted: gen.messagesCreated,
      messageStatuses: [...new Set((msgs ?? []).map((m) => m.status))],
      sampleMessage: msgs?.[0]?.message_text?.slice(0, 120),
      noSmsOnGenerate: noSms,
      outboundPageStatus,
    },
    null,
    2
  )
);
