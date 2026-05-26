/**
 * Re-run Whoosh slow-time QA after ai_opportunities truth columns applied.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
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
}

loadEnvLocal();

const metrics = {
  whooshWindowsSynced: 0,
  whooshWindowsCached: 0,
  slowTimeOpportunitiesCreated: 0,
  slowTargets: 0,
  campaignMessagesDrafted: 0,
  campaignId: null,
  campaignStatus: null,
  messageStatuses: [],
  outboundPageStatus: null,
  blocker: null,
};

async function main() {
  const businessId = process.env.CLOSEOS_BUSINESS_ID?.trim();
  if (!businessId) {
    metrics.blocker = "CLOSEOS_BUSINESS_ID missing";
    printReport();
    process.exit(1);
  }

  const { createSupabaseServiceRoleClient } = await import("../lib/supabase/admin.ts");
  const { syncWhooshAvailabilityWindows } = await import(
    "../lib/whoosh/sync-availability-windows.ts"
  );
  const { refreshWhooshSlowTimeOpportunities } = await import(
    "../lib/whoosh/slow-time-opportunities.ts"
  );
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

  // Truth columns probe
  for (const col of ["counts_toward_pipeline", "pipeline_category"]) {
    const { error } = await supabase
      .from("ai_opportunities")
      .select(`id,${col}`)
      .eq("business_id", businessId)
      .limit(1);
    if (error) {
      metrics.blocker = `ai_opportunities.${col} still missing: ${error.message}`;
      printReport();
      process.exit(1);
    }
  }
  console.log("OK  truth columns present on ai_opportunities");

  // 1. Sync
  console.log("RUN Whoosh availability sync…");
  const sync = await syncWhooshAvailabilityWindows({
    supabase,
    businessId,
    daysAhead: 10,
  });
  if (!sync.ok) {
    metrics.blocker = `Whoosh sync failed: ${sync.error}${sync.details ? ` (${sync.details})` : ""}`;
    printReport();
    process.exit(1);
  }
  metrics.whooshWindowsSynced = sync.windowsSynced;
  console.log(`OK  synced ${sync.windowsSynced} windows (${sync.startDate}–${sync.endDate})`);

  const { count: cachedCount } = await supabase
    .from("whoosh_availability_windows")
    .select("*", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("bookable", true);
  metrics.whooshWindowsCached = cachedCount ?? 0;

  // 2. Explicit refresh + count opportunities
  const refresh = await refreshWhooshSlowTimeOpportunities({
    supabase,
    businessId,
    startDate: sync.startDate,
    endDate: sync.endDate,
  });
  console.log(
    `OK  refreshWhooshSlowTimeOpportunities upserted ${refresh.opportunitiesUpserted} (windowCount=${refresh.windowCount})`
  );

  const { count: oppCount } = await supabase
    .from("ai_opportunities")
    .select("*", { count: "exact", head: true })
    .eq("business_id", businessId)
    .eq("source", "whoosh_availability")
    .in("status", ["open", "queued"]);
  metrics.slowTimeOpportunitiesCreated = oppCount ?? refresh.opportunitiesUpserted ?? 0;

  if (metrics.slowTimeOpportunitiesCreated === 0) {
    metrics.blocker =
      "refreshWhooshSlowTimeOpportunities created 0 opportunities — check customer_profiles with phones";
    printReport();
    process.exit(1);
  }

  // 3. slowTargets
  const allTargets = await loadOutboundOpportunityTargets({ supabase, businessId });
  const slowFiltered = filterTargetsByCampaignFocus(allTargets, "slow_time");
  metrics.slowTargets = slowFiltered.length;
  console.log(`OK  slowTargets=${slowFiltered.length} (of ${allTargets.length} total)`);

  if (slowFiltered.length === 0) {
    metrics.blocker =
      "slowTargets=0 after opportunities created — targeting filter or phone eligibility issue";
    printReport();
    process.exit(1);
  }

  // 4. Generate slow_time campaign
  const gen = await generateAiCampaignDraft({
    supabase,
    businessId,
    userId: "qa-rerun",
    campaignFocus: "slow_time",
    maxTargets: 25,
    loadTargets: async () => slowFiltered,
  });

  if (!gen.ok) {
    metrics.blocker = `Campaign generation failed: ${gen.error ?? gen.reason ?? "unknown"}`;
    printReport();
    process.exit(1);
  }

  metrics.campaignId = gen.campaign.id;
  metrics.campaignStatus = gen.campaign.status;
  metrics.campaignMessagesDrafted = gen.messagesCreated;
  console.log(
    `OK  draft campaign ${gen.campaign.id} with ${gen.messagesCreated} message(s)`
  );

  // 5. Draft-only verification
  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("id, status, source")
    .eq("id", gen.campaign.id)
    .single();

  const { data: msgRows } = await supabase
    .from("campaign_messages")
    .select("id, status")
    .eq("campaign_id", gen.campaign.id);

  metrics.messageStatuses = [...new Set((msgRows ?? []).map((m) => m.status))];

  if (campaignRow?.status !== "draft" || campaignRow?.source !== "ai_generated") {
    metrics.blocker = `Campaign not draft-only: status=${campaignRow?.status} source=${campaignRow?.source}`;
  } else if (metrics.messageStatuses.some((s) => s !== "draft")) {
    metrics.blocker = `Non-draft message statuses: ${metrics.messageStatuses.join(", ")}`;
  } else {
    console.log("OK  campaign + messages are draft-only");
  }

  // 6. No SMS on generate (static)
  const genSource = readFileSync(
    resolve(process.cwd(), "lib/campaigns/generate-campaign.ts"),
    "utf8"
  );
  if (genSource.includes("sendMessage") || genSource.includes("sendSentDmMessage")) {
    metrics.blocker = metrics.blocker ?? "generate-campaign.ts references SMS send path";
  } else {
    console.log("OK  no SMS send path in generate-campaign.ts");
  }

  // 7. /outbound/{campaignId} route exists + dev fetch if server up
  const pagePath = resolve(
    process.cwd(),
    "app/(dashboard)/outbound/[campaignId]/page.tsx"
  );
  if (!readFileSync(pagePath, "utf8").includes("campaignId")) {
    metrics.blocker = metrics.blocker ?? "Outbound detail page missing";
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000";
  try {
    const res = await fetch(`${appUrl}/outbound/${gen.campaign.id}`, {
      redirect: "manual",
      headers: { Accept: "text/html" },
    });
    metrics.outboundPageStatus = res.status;
    if (res.status === 404) {
      metrics.blocker = metrics.blocker ?? `/outbound/${gen.campaign.id} returned 404`;
    } else if (res.status >= 500) {
      metrics.blocker = metrics.blocker ?? `/outbound/${gen.campaign.id} returned ${res.status}`;
    } else {
      console.log(
        `OK  GET /outbound/${gen.campaign.id} → HTTP ${res.status} (auth redirect acceptable)`
      );
    }
  } catch {
    console.log(
      `SKIP  dev server not running — route file verified; start app to HTTP-test /outbound/${gen.campaign.id}`
    );
    metrics.outboundPageStatus = "dev-server-not-running";
  }

  printReport();
  if (metrics.blocker) process.exit(1);
}

function printReport() {
  console.log("\n=== WHOOSH SLOW-TIME QA RERUN ===");
  console.log(JSON.stringify(metrics, null, 2));
}

main().catch((e) => {
  metrics.blocker = e instanceof Error ? e.message : String(e);
  printReport();
  process.exit(1);
});
