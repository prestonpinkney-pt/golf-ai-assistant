/**
 * One-off production QA for Whoosh-backed slow-time campaigns.
 * Usage: node --import ./tests/stub-server-only.cjs --import tsx scripts/qa-whoosh-slow-time.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
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
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

loadEnvLocal();

const EXPECTED_WHOOSH_COLUMNS = [
  "id",
  "business_id",
  "whoosh_window_id",
  "starts_at",
  "ends_at",
  "timezone",
  "resource_id",
  "resource_name",
  "resource_type",
  "bookable",
  "capacity",
  "raw",
  "synced_at",
  "created_at",
  "updated_at",
];

const results = [];

function pass(id, detail) {
  results.push({ id, status: "PASS", detail });
  console.log(`PASS  ${id}: ${detail}`);
}

function fail(id, detail) {
  results.push({ id, status: "FAIL", detail });
  console.log(`FAIL  ${id}: ${detail}`);
}

function skip(id, detail) {
  results.push({ id, status: "SKIP", detail });
  console.log(`SKIP  ${id}: ${detail}`);
}

const TIME_RE = /\b\d{1,2}:\d{2}\s*(am|pm)?\b/i;

async function main() {
  const businessId = process.env.CLOSEOS_BUSINESS_ID?.trim();
  if (!businessId) {
    fail("env", "CLOSEOS_BUSINESS_ID missing");
    return;
  }

  const { createSupabaseServiceRoleClient } = await import(
    "../lib/supabase/admin.ts"
  );
  const { isWhooshServerConfigured } = await import("../lib/whoosh/client.ts");
  const { syncWhooshAvailabilityWindows } = await import(
    "../lib/whoosh/sync-availability-windows.ts"
  );
  const { generateAiCampaignDraft } = await import(
    "../lib/campaigns/generate-campaign.ts"
  );
  const { loadOutboundOpportunityTargets } = await import(
    "../app/api/lib/opportunity-eligible-targets.ts"
  );
  const { filterTargetsByCampaignFocus } = await import(
    "../lib/campaigns/campaign-focus.ts"
  );
  const { readFileSync: readFs } = await import("node:fs");

  // 1. Migration file present
  const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/20260525120000_whoosh_availability_windows.sql"
  );
  const migrationSql = readFs(migrationPath, "utf8");
  if (
    migrationSql.includes("whoosh_availability_windows") &&
    migrationSql.includes("ai_opportunities") &&
    migrationSql.includes("metadata jsonb")
  ) {
    pass(
      "1-migration-file",
      "20260525120000_whoosh_availability_windows.sql present with table + metadata alter"
    );
  } else {
    fail("1-migration-file", "Migration file incomplete");
  }

  const supabase = createSupabaseServiceRoleClient();

  // 2. whoosh_availability_windows table + columns
  const { data: sampleRow, error: tableErr } = await supabase
    .from("whoosh_availability_windows")
    .select("*")
    .limit(1);

  if (tableErr) {
    fail(
      "2-whoosh-table",
      `Table missing or inaccessible: ${tableErr.message}`
    );
  } else {
    const row = sampleRow?.[0] ?? {};
    const cols = new Set(Object.keys(row));
    if (sampleRow?.length === 0) {
      // empty table — probe insert/select metadata via PostgREST head
      const { error: probeErr } = await supabase
        .from("whoosh_availability_windows")
        .select(
          "id,business_id,whoosh_window_id,starts_at,ends_at,timezone,resource_id,resource_name,resource_type,bookable,capacity,raw,synced_at,created_at,updated_at"
        )
        .limit(0);
      if (probeErr) {
        fail("2-whoosh-table", probeErr.message);
      } else {
        pass(
          "2-whoosh-table",
          `Table exists with expected columns (${EXPECTED_WHOOSH_COLUMNS.length} cols); 0 rows cached`
        );
      }
    } else {
      const missing = EXPECTED_WHOOSH_COLUMNS.filter((c) => !cols.has(c));
      if (missing.length) {
        fail("2-whoosh-table", `Missing columns: ${missing.join(", ")}`);
      } else {
        pass(
          "2-whoosh-table",
          `Table exists with all expected columns; ${sampleRow.length} sample row(s)`
        );
      }
    }
  }

  // 3. ai_opportunities.metadata
  const { data: oppSample, error: oppErr } = await supabase
    .from("ai_opportunities")
    .select("id, metadata")
    .eq("business_id", businessId)
    .limit(1);

  if (oppErr?.message?.includes("metadata")) {
    fail("3-ai-opportunities-metadata", oppErr.message);
  } else if (oppErr) {
    fail("3-ai-opportunities-metadata", oppErr.message);
  } else {
    const meta = oppSample?.[0]?.metadata;
    const okMeta =
      meta === undefined ||
      meta === null ||
      (typeof meta === "object" && !Array.isArray(meta));
    if (okMeta) {
      pass(
        "3-ai-opportunities-metadata",
        `metadata jsonb readable (${oppSample?.length ?? 0} sample row(s))`
      );
    } else {
      fail("3-ai-opportunities-metadata", "metadata column has unexpected type");
    }
  }

  // 4. Whoosh sync with real env
  if (!isWhooshServerConfigured()) {
    skip("4-whoosh-sync", "Whoosh env not fully configured");
  } else {
    const sync = await syncWhooshAvailabilityWindows({
      supabase,
      businessId,
      daysAhead: 10,
    });
    if (!sync.ok) {
      fail("4-whoosh-sync", `${sync.error}${sync.details ? ` (${sync.details})` : ""}`);
    } else {
      pass(
        "4-whoosh-sync",
        `Synced ${sync.windowsSynced} windows for ${sync.startDate}–${sync.endDate}`
      );
    }
  }

  // 5. Slow-time opportunities only from Whoosh-verified source
  const { data: whooshOpps, error: whooshOppErr } = await supabase
    .from("ai_opportunities")
    .select(
      "id, recognized_opportunity, source, metadata, status"
    )
    .eq("business_id", businessId)
    .eq("source", "whoosh_availability")
    .in("status", ["open", "queued"]);

  if (whooshOppErr) {
    fail("5-whoosh-opportunities", whooshOppErr.message);
  } else {
    const bad = (whooshOpps ?? []).filter((o) => {
      const m = o.metadata ?? {};
      return (
        m.availability_source !== "whoosh" || m.availability_verified !== true
      );
    });
    if (bad.length) {
      fail(
        "5-whoosh-opportunities",
        `${bad.length} whoosh_availability row(s) missing verified metadata`
      );
    } else if ((whooshOpps ?? []).length === 0) {
      skip(
        "5-whoosh-opportunities",
        "No open whoosh_availability opportunities (sync may have returned 0 windows or no customer profiles)"
      );
    } else {
      pass(
        "5-whoosh-opportunities",
        `${whooshOpps.length} open opportunity(ies) with availability_verified=true`
      );
    }
  }

  // Load targets for generate tests
  let allTargets = [];
  try {
    allTargets = await loadOutboundOpportunityTargets({ supabase, businessId });
  } catch (e) {
    fail("targets-load", e instanceof Error ? e.message : String(e));
  }

  const slowFiltered = filterTargetsByCampaignFocus(allTargets, "slow_time");
  const unverifiedOnly = allTargets.filter(
    (t) => !t.availabilityVerified || t.availabilitySource !== "whoosh"
  );

  // 6. slow_time refuses without verified availability
  const refuse = await generateAiCampaignDraft({
    supabase,
    businessId,
    userId: "qa-script",
    campaignFocus: "slow_time",
    loadTargets: async () => unverifiedOnly,
  });
  if (
    !refuse.ok &&
    refuse.reason === "whoosh_availability_required" &&
    refuse.errorCode === "whoosh_availability_required"
  ) {
    pass(
      "6-slow-time-refuse",
      "Returns whoosh_availability_required when no verified targets"
    );
  } else if (!refuse.ok && refuse.reason === "whoosh_availability_required") {
    pass("6-slow-time-refuse", "Returns whoosh_availability_required");
  } else {
    fail(
      "6-slow-time-refuse",
      refuse.ok
        ? "Unexpected success with unverified-only targets"
        : `Got reason=${refuse.reason ?? "unknown"}`
    );
  }

  // 7. slow_time creates draft when verified windows exist
  if (slowFiltered.length === 0) {
    skip(
      "7-slow-time-draft",
      "No Whoosh-verified slow-time targets in DB after sync"
    );
  } else {
    const gen = await generateAiCampaignDraft({
      supabase,
      businessId,
      userId: "qa-script",
      campaignFocus: "slow_time",
      maxTargets: 5,
      loadTargets: async () => slowFiltered,
    });
    if (!gen.ok) {
      fail(
        "7-slow-time-draft",
        gen.reason === "setup_required" || gen.reason === "migration_missing"
          ? `Campaign tables missing: ${gen.setupMessage ?? gen.error}`
          : gen.error ?? gen.reason
      );
    } else {
      const status = gen.campaign.status;
      const source = gen.campaign.source;
      if (status === "draft" && source === "ai_generated") {
        pass(
          "7-slow-time-draft",
          `Created draft campaign ${gen.campaign.id} with ${gen.messagesCreated} message(s)`
        );

        // cleanup QA campaign
        const cid = gen.campaign.id;
        await supabase.from("campaign_messages").delete().eq("campaign_id", cid);
        await supabase.from("campaigns").delete().eq("id", cid);

        // 8. Messages do not promise exact times
        const { data: msgs } = await supabase
          .from("campaign_messages")
          .select("message_text")
          .eq("campaign_id", cid);
        void msgs;
      } else {
        fail("7-slow-time-draft", `Unexpected status=${status} source=${source}`);
      }

      // Check message text from generation result path — re-read before delete
      const gen2 = await generateAiCampaignDraft({
        supabase,
        businessId,
        userId: "qa-script",
        campaignFocus: "slow_time",
        maxTargets: 3,
        loadTargets: async () => slowFiltered.slice(0, 3),
      });
      if (gen2.ok) {
        const { data: draftMsgs } = await supabase
          .from("campaign_messages")
          .select("message_text, status")
          .eq("campaign_id", gen2.campaign.id);
        const texts = (draftMsgs ?? []).map((m) => m.message_text ?? "");
        const withTimes = texts.filter((t) => TIME_RE.test(t));
        if (withTimes.length) {
          fail(
            "8-no-exact-times",
            `Message(s) contain clock times: ${withTimes[0]?.slice(0, 80)}`
          );
        } else {
          pass(
            "8-no-exact-times",
            `${texts.length} draft message(s) — no HH:MM patterns`
          );
        }
        const nonDraft = (draftMsgs ?? []).filter((m) => m.status !== "draft");
        if (nonDraft.length) {
          fail("8-no-exact-times", "Some messages not in draft status");
        }
        await supabase
          .from("campaign_messages")
          .delete()
          .eq("campaign_id", gen2.campaign.id);
        await supabase.from("campaigns").delete().eq("id", gen2.campaign.id);
      }
    }
  }

  // 9. No SMS during generation (static check)
  const genSource = readFs(
    resolve(process.cwd(), "lib/campaigns/generate-campaign.ts"),
    "utf8"
  );
  if (
    !genSource.includes("sendMessage") &&
    !genSource.includes("sendSentDmMessage")
  ) {
    pass("9-no-sms-on-generate", "generate-campaign.ts has no send imports/calls");
  } else {
    fail("9-no-sms-on-generate", "generate-campaign.ts references send path");
  }

  // 10. Approval required before send
  const sendSource = readFs(
    resolve(process.cwd(), "app/api/campaigns/[campaignId]/send/route.ts"),
    "utf8"
  );
  if (
    sendSource.includes('.eq("status", "approved")') &&
    sendSource.includes("sendMessage")
  ) {
    pass(
      "10-approval-required",
      "Send route only loads approved messages before sendMessage"
    );
  } else {
    fail("10-approval-required", "Send route approval gate not confirmed");
  }

  console.log("\n--- QA SUMMARY ---");
  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  console.log(`PASS: ${passed}  FAIL: ${failed}  SKIP: ${skipped}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
