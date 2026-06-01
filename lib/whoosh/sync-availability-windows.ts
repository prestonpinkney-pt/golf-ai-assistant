import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

import { getWhooshAvailability } from "@/lib/whoosh/availability-windows";
import { getWhooshTimezone } from "@/lib/whoosh/availability-windows";
import type { WhooshAvailabilitySyncResult } from "@/lib/whoosh/types";
import { refreshWhooshSlowTimeOpportunities } from "@/lib/whoosh/slow-time-opportunities";

export type SyncWhooshAvailabilityInput = {
  supabase: SupabaseClient;
  businessId: string;
  /** Days ahead from today (default 10, max 14). */
  daysAhead?: number;
};

export async function syncWhooshAvailabilityWindows(
  input: SyncWhooshAvailabilityInput
): Promise<WhooshAvailabilitySyncResult> {
  const tz = getWhooshTimezone();
  const days = Math.min(Math.max(input.daysAhead ?? 10, 7), 14);
  const startDate = DateTime.now().setZone(tz).toFormat("yyyy-MM-dd");
  const endDate = DateTime.now()
    .setZone(tz)
    .plus({ days })
    .toFormat("yyyy-MM-dd");

  const fetched = await getWhooshAvailability({
    startDate,
    endDate,
    resourceType: "simulator",
  });

  if (!fetched.ok) {
    return { ok: false, error: fetched.error, details: fetched.details };
  }

  const now = new Date().toISOString();
  const startIso = new Date(startDate).toISOString();
  const endIso = new Date(`${endDate}T23:59:59.999Z`).toISOString();
  let windowsSynced = 0;

  const { error: staleError } = await input.supabase
    .from("whoosh_availability_windows")
    .update({
      bookable: false,
      synced_at: now,
      updated_at: now,
    })
    .eq("business_id", input.businessId)
    .eq("bookable", true)
    .gte("starts_at", startIso)
    .lte("ends_at", endIso)
    .in("resource_type", ["simulator", "bay"]);

  if (staleError) {
    console.error("[whoosh-sync] stale window invalidation failed:", staleError.message);
  }

  for (const w of fetched.windows) {
    const row = {
      business_id: input.businessId,
      whoosh_window_id: w.id,
      starts_at: w.startsAt,
      ends_at: w.endsAt,
      timezone: w.timezone,
      resource_id: w.resourceId,
      resource_name: w.resourceName,
      resource_type: w.resourceType,
      bookable: w.bookable,
      capacity: w.capacity ?? null,
      raw: w.raw ?? {},
      synced_at: now,
      updated_at: now,
    };

    const { error } = await input.supabase
      .from("whoosh_availability_windows")
      .upsert(row, { onConflict: "business_id,whoosh_window_id" });

    if (error) {
      console.error("[whoosh-sync] upsert failed:", error.message, w.id);
      continue;
    }
    windowsSynced += 1;
  }

  try {
    await refreshWhooshSlowTimeOpportunities({
      supabase: input.supabase,
      businessId: input.businessId,
      startDate,
      endDate,
    });
  } catch (err) {
    console.error("[whoosh-sync] slow-time opportunity refresh:", err);
  }

  return {
    ok: true,
    windowsSynced,
    startDate,
    endDate,
    source: "whoosh",
  };
}
