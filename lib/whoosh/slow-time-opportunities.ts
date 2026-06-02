import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

import { truthFieldsForDb } from "@/app/api/lib/closeos-opportunity-truth";
import { loadWhooshAvailabilityWindows } from "@/lib/whoosh/load-availability-windows";
import { getWhooshTimezone } from "@/lib/whoosh/availability-windows";
import type {
  WhooshAvailabilityWindow,
  WhooshOpportunityMetadata,
  WhooshSlowTimeRecognizedOpportunity,
} from "@/lib/whoosh/types";

const SOURCE = "whoosh_availability" as const;

type DaypartKind = "weekday" | "sunday" | "general";

function classifyWindowDaypart(w: WhooshAvailabilityWindow): DaypartKind {
  const dt = DateTime.fromISO(w.startsAt, { zone: w.timezone || getWhooshTimezone() });
  const weekday = dt.weekday;
  const hour = dt.hour + dt.minute / 60;

  if (weekday === 7) return "sunday";
  if (weekday >= 3 && weekday <= 5 && hour < 17) return "weekday";
  return "general";
}

function recognizedForDaypart(daypart: DaypartKind): WhooshSlowTimeRecognizedOpportunity {
  if (daypart === "sunday") return "sunday_open_bay_fill";
  if (daypart === "weekday") return "weekday_open_bay_fill";
  return "simulator_open_bay_fill";
}

function playbookForRecognized(ro: WhooshSlowTimeRecognizedOpportunity): string {
  switch (ro) {
    case "sunday_open_bay_fill":
      return "sunday-simulator-fill";
    case "weekday_open_bay_fill":
      return "weekday-simulator-fill";
    case "slow_time_fill":
      return "slow-time-fill";
    default:
      return "simulator-open-bay-fill";
  }
}

function buildMetadata(windows: WhooshAvailabilityWindow[]): WhooshOpportunityMetadata {
  const dayparts = [...new Set(windows.map(classifyWindowDaypart))];
  return {
    availability_source: "whoosh",
    availability_verified: true,
    whoosh_window_ids: windows.map((w) => w.id).slice(0, 50),
    window_count: windows.length,
    suggested_dayparts: dayparts,
  };
}

async function markWhooshSlowTimeOpportunitiesStale(input: {
  supabase: SupabaseClient;
  businessId: string;
}): Promise<void> {
  const { error } = await input.supabase
    .from("ai_opportunities")
    .update({
      status: "stale",
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", input.businessId)
    .eq("source", SOURCE)
    .in("status", ["open", "queued"]);

  if (error) {
    console.error("[whoosh-sync] stale opportunity update:", error.message);
  }
}

export async function refreshWhooshSlowTimeOpportunities(input: {
  supabase: SupabaseClient;
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<{ opportunitiesUpserted: number; windowCount: number }> {
  const windows = await loadWhooshAvailabilityWindows({
    supabase: input.supabase,
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    resourceType: "simulator",
  });

  if (windows.length === 0) {
    await markWhooshSlowTimeOpportunitiesStale({
      supabase: input.supabase,
      businessId: input.businessId,
    });
    return { opportunitiesUpserted: 0, windowCount: 0 };
  }

  const metadata = buildMetadata(windows);
  const primaryDaypart = classifyWindowDaypart(windows[0]!);
  const recognized = recognizedForDaypart(primaryDaypart);
  const playbook = playbookForRecognized(recognized);
  const truth = truthFieldsForDb(recognized);

  const { data: profiles, error: profileErr } = await input.supabase
    .from("customer_profiles")
    .select("id, phone, exclude_from_ai_targeting, visit_count, total_spend_cents")
    .eq("business_id", input.businessId)
    .eq("exclude_from_ai_targeting", false)
    .not("phone", "is", null)
    .order("last_purchase_at", { ascending: false, nullsFirst: false })
    .limit(50);

  if (profileErr || !profiles?.length) {
    return { opportunitiesUpserted: 0, windowCount: windows.length };
  }

  let opportunitiesUpserted = 0;
  const signalSummary = `Whoosh verified ${windows.length} bookable simulator/bay window(s) for ${input.startDate}–${input.endDate}.`;

  for (const profile of profiles) {
    const phone = typeof profile.phone === "string" ? profile.phone.trim() : "";
    if (!phone) continue;

    const customerProfileId = profile.id as string;

    const { data: existing } = await input.supabase
      .from("ai_opportunities")
      .select("id")
      .eq("business_id", input.businessId)
      .eq("customer_profile_id", customerProfileId)
      .eq("recognized_opportunity", recognized)
      .eq("source", SOURCE)
      .in("status", ["open", "queued"])
      .maybeSingle();

    const payload = {
      business_id: input.businessId,
      customer_profile_id: customerProfileId,
      recognized_opportunity: recognized,
      opportunity_type: "slow_time",
      playbook,
      status: "open",
      priority: 75,
      confidence: 82,
      estimated_revenue_cents: truth.estimated_revenue_cents ?? 4500,
      revenue_review_required: truth.revenue_review_required ?? false,
      counts_toward_pipeline: truth.counts_toward_pipeline ?? true,
      pipeline_category: truth.pipeline_category ?? "known_pipeline",
      offer_key: truth.offer_key ?? null,
      source: SOURCE,
      signal_summary: signalSummary,
      next_best_action: "Review Whoosh-backed slow-time SMS and approve before send.",
      reply_handling_goal: "Book verified simulator time when guest replies.",
      recommended_message: null,
      metadata,
      updated_at: new Date().toISOString(),
    };

    if (existing?.id) {
      const { error } = await input.supabase
        .from("ai_opportunities")
        .update(payload)
        .eq("id", existing.id);
      if (!error) opportunitiesUpserted += 1;
    } else {
      const { error } = await input.supabase.from("ai_opportunities").insert(payload);
      if (!error) opportunitiesUpserted += 1;
    }
  }

  return { opportunitiesUpserted, windowCount: windows.length };
}
