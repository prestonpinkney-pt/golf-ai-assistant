export type WhooshResourceType = "simulator" | "bay" | "lesson" | "unknown";

export type WhooshResourceTypeFilter = "simulator" | "bay" | "lesson" | "all";

export type WhooshAvailabilityWindow = {
  id: string;
  source: "whoosh";
  startsAt: string;
  endsAt: string;
  timezone: string;
  resourceId: string | null;
  resourceName: string | null;
  resourceType: WhooshResourceType;
  bookable: boolean;
  capacity?: number | null;
  raw?: unknown;
};

export type GetWhooshAvailabilityInput = {
  startDate: string;
  endDate: string;
  facilityId?: string | null;
  resourceType?: WhooshResourceTypeFilter;
};

export type GetWhooshAvailabilityResult =
  | { ok: true; windows: WhooshAvailabilityWindow[]; fetchedAtIso: string }
  | { ok: false; error: string; details?: string };

export type WhooshAvailabilitySyncResult =
  | {
      ok: true;
      windowsSynced: number;
      startDate: string;
      endDate: string;
      source: "whoosh";
    }
  | { ok: false; error: string; details?: string };

export type WhooshSlowTimeRecognizedOpportunity =
  | "slow_time_fill"
  | "weekday_open_bay_fill"
  | "sunday_open_bay_fill"
  | "simulator_open_bay_fill";

export const WHOOSH_SLOW_TIME_RECOGNIZED: readonly string[] = [
  "slow_time_fill",
  "weekday_open_bay_fill",
  "sunday_open_bay_fill",
  "simulator_open_bay_fill",
  "simulator_rebooking_due",
  "simulator_recent_guest_follow_up",
  "simulator_cancelled_recovery",
  "mailchimp_simulator_interest",
];

export type WhooshOpportunityMetadata = {
  availability_source: "whoosh";
  availability_verified: boolean;
  whoosh_window_ids: string[];
  window_count: number;
  suggested_dayparts: string[];
};
