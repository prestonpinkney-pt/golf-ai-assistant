import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhooshAvailabilityWindow, WhooshResourceTypeFilter } from "@/lib/whoosh/types";

export type LoadWhooshAvailabilityWindowsInput = {
  supabase: SupabaseClient;
  businessId: string;
  startDate: string;
  endDate: string;
  resourceType?: WhooshResourceTypeFilter;
};

function rowToWindow(row: Record<string, unknown>): WhooshAvailabilityWindow {
  return {
    id: String(row.whoosh_window_id ?? row.id ?? ""),
    source: "whoosh",
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    timezone: String(row.timezone ?? "America/Los_Angeles"),
    resourceId: (row.resource_id as string | null) ?? null,
    resourceName: (row.resource_name as string | null) ?? null,
    resourceType:
      (row.resource_type as WhooshAvailabilityWindow["resourceType"]) ?? "unknown",
    bookable: row.bookable !== false,
    capacity: (row.capacity as number | null) ?? null,
    raw: row.raw,
  };
}

export function mapWhooshCacheRowToWindow(
  row: Record<string, unknown>
): WhooshAvailabilityWindow {
  return rowToWindow(row);
}

export async function loadWhooshAvailabilityWindows(
  input: LoadWhooshAvailabilityWindowsInput
): Promise<WhooshAvailabilityWindow[]> {
  const startIso = new Date(input.startDate).toISOString();
  const endIso = new Date(`${input.endDate}T23:59:59.999Z`).toISOString();

  let q = input.supabase
    .from("whoosh_availability_windows")
    .select("*")
    .eq("business_id", input.businessId)
    .eq("bookable", true)
    .gte("starts_at", startIso)
    .lte("ends_at", endIso)
    .order("starts_at", { ascending: true });

  const filter = input.resourceType ?? "all";
  if (filter === "simulator") {
    q = q.in("resource_type", ["simulator", "bay"]);
  } else if (filter === "bay") {
    q = q.in("resource_type", ["bay", "simulator"]);
  } else if (filter === "lesson") {
    q = q.eq("resource_type", "lesson");
  }

  const { data, error } = await q;
  if (error) {
    console.error("[loadWhooshAvailabilityWindows]", error.message);
    return [];
  }

  return (data ?? []).map((row) => rowToWindow(row as Record<string, unknown>));
}

export async function countVerifiedWhooshWindows(
  input: LoadWhooshAvailabilityWindowsInput
): Promise<number> {
  const windows = await loadWhooshAvailabilityWindows(input);
  return windows.length;
}
