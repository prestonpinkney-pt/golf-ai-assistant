import "server-only";

import { DateTime } from "luxon";

/** Primetime simulator public access uses this IANA zone. */
export const PRIMETIME_BUSINESS_TIMEZONE = "America/Los_Angeles";

/**
 * Public hours (Primetime Golf, non-members): calendar Wed–Sun, and each slot must START
 * between 11:00 AM and 9:00 PM inclusive in America/Los_Angeles (`minuteOfDay` in
 * [11×60, 21×60]). A slot starting strictly after 9:00 PM (e.g. 9:05 PM) is not public bookable.
 */
const PUBLIC_START_MINUTE = 11 * 60;
const PUBLIC_END_MINUTE = 21 * 60;

/** Luxon weekdays: Monday=1 … Sunday=7. Public days: Wed(3)–Sun(7). */
function isPublicCalendarDay(weekday: number): boolean {
  return weekday >= 3 && weekday <= 7;
}

function minuteOfDayFromDateTime(dt: DateTime): number {
  return dt.hour * 60 + dt.minute;
}

/** True when this local instant is inside Primetime public access rules (non-member). */
export function isPublicBookableMoment(dt: DateTime): boolean {
  if (!dt.isValid) return false;
  if (dt.zoneName !== PRIMETIME_BUSINESS_TIMEZONE) {
    return isPublicBookableMoment(dt.setZone(PRIMETIME_BUSINESS_TIMEZONE));
  }
  const weekday = dt.weekday;
  if (!isPublicCalendarDay(weekday)) return false;
  const mod = minuteOfDayFromDateTime(dt);
  return mod >= PUBLIC_START_MINUTE && mod <= PUBLIC_END_MINUTE;
}

export const PRIMETIME_OPPORTUNITY_BUSINESS_HOURS = {
  publicHours: "Wed–Sun 11:00 AM–9:00 PM",
  memberAccess: "24/7",
  timezone: PRIMETIME_BUSINESS_TIMEZONE,
} as const;

export type WhooshAggSlotRow = {
  course_id: string | null;
  course_name: string | null;
  agenda_date?: string | null;
  slot_date?: string | null;
  time: string | null;
  capacity: number | null;
  used_capacity: number | null;
  type?: string | null;
};

export type WhooshAggBookingRow = {
  course_id: string | null;
  booking_time: string | null;
  deleted_at?: string | null;
};

/** Parse slot/display time onto agenda_date in LA — multiple Whoosh formats. */
export function parseSlotLocalDateTime(input: {
  agendaDateYmd: string;
  timeRaw: string | null;
}): DateTime | null {
  const t = input.timeRaw?.trim();
  if (!t) return null;
  const base = `${input.agendaDateYmd.trim()} ${t}`;
  const formats = [
    "yyyy-MM-dd h:mm a",
    "yyyy-MM-dd hh:mm a",
    "yyyy-MM-dd H:mm",
    "yyyy-MM-dd HH:mm",
    "yyyy-MM-dd h:mma",
    "yyyy-MM-dd ha",
  ];
  for (const fmt of formats) {
    const dt = DateTime.fromFormat(base, fmt, { zone: PRIMETIME_BUSINESS_TIMEZONE });
    if (dt.isValid) return dt;
  }
  const loose = DateTime.fromISO(`${input.agendaDateYmd}T${t}`, {
    zone: PRIMETIME_BUSINESS_TIMEZONE,
  });
  if (loose.isValid) return loose;
  return null;
}

function isSlotOpen(s: WhooshAggSlotRow): boolean {
  const used = s.used_capacity ?? 0;
  const cap = s.capacity ?? 1;
  return used < cap;
}

/** Labels for outbound opportunity rows (no PII). */
export type OpportunityAudienceLabels = {
  audience: "public" | "members";
  availabilityScope: "public_hours" | "member_24_7";
  isPublicBookable: boolean;
  isMemberBookable: boolean;
};

function labelsForMoment(dt: DateTime | null): OpportunityAudienceLabels {
  if (!dt || !dt.isValid) {
    return {
      audience: "members",
      availabilityScope: "member_24_7",
      isPublicBookable: false,
      isMemberBookable: true,
    };
  }
  const local = dt.setZone(PRIMETIME_BUSINESS_TIMEZONE);
  const pub = isPublicBookableMoment(local);
  return {
    audience: pub ? "public" : "members",
    availabilityScope: pub ? "public_hours" : "member_24_7",
    isPublicBookable: pub,
    isMemberBookable: true,
  };
}

/** Midpoint of clock hour `hour` uses :30 — public labels match spec without treating 21:30 as public bookable. */
function hourBucketAudience(hour: number, agendaDateYmd: string): OpportunityAudienceLabels {
  const hh = hour.toString().padStart(2, "0");
  const midpoint = DateTime.fromFormat(
    `${agendaDateYmd} ${hh}:30`,
    "yyyy-MM-dd HH:mm",
    { zone: PRIMETIME_BUSINESS_TIMEZONE }
  );
  return labelsForMoment(midpoint);
}

export type OpportunityItem = OpportunityAudienceLabels & {
  type: string;
  priority: "high" | "medium" | "normal";
  title: string;
  reason: string;
  suggestedAction: string;
  estimatedValueLabel: string;
  source: string;
};

export type SlowWindowItem = OpportunityAudienceLabels & {
  label: string;
  startTime: string;
  endTime: string;
  course_id: string | null;
  course_name: string | null;
  openSlots: number;
  reason: string;
  suggestedAction: string;
};

export type ByCourseAgg = OpportunityAudienceLabels & {
  course_id: string | null;
  course_name: string | null;
  totalSlots: number;
  bookedSlots: number;
  openSlots: number;
  utilizationPct: number;
  totalCapacity: number;
  usedCapacity: number;
};

export type OpportunitiesComputeResult = {
  ok: true;
  agenda_date: string;
  facility_slug: string;
  businessHours: typeof PRIMETIME_OPPORTUNITY_BUSINESS_HOURS;
  summary: {
    totalSlots: number;
    totalBookings: number;
    bookingCount: number;
    openSlots: number;
    bookedSlots: number;
    utilizationPct: number;
    publicUtilizationPct: number | null;
    slotsOpenOutsidePublicHours: number;
    slotsOpenInsidePublicHours: number;
    unparseableTimeCount: number;
    totalCapacity: number;
    usedCapacity: number;
    publicHourCapacityDenom: number;
    publicHourUsedNumerator: number;
  };
  byCourse: ByCourseAgg[];
  slowWindows: SlowWindowItem[];
  opportunities: OpportunityItem[];
};

const EST_VALUE_OPS = "Rate-dependent — use internal pricing grid";

export function computeWhooshAgendaOpportunities(input: {
  agenda_date: string;
  facility_slug: string;
  slots: WhooshAggSlotRow[];
  bookings: WhooshAggBookingRow[];
}): OpportunitiesComputeResult {
  const { agenda_date, facility_slug, slots } = input;
  let unparseableTimeCount = 0;

  type EnrichedSlot = WhooshAggSlotRow & {
    parsed: DateTime | null;
    publicBookableForSlot: boolean;
    labels: OpportunityAudienceLabels;
    open: boolean;
    minuteOfDay: number | null;
  };

  const enriched: EnrichedSlot[] = slots.map((s) => {
    const agenda = (s.slot_date ?? s.agenda_date ?? agenda_date).trim();
    const parsed = parseSlotLocalDateTime({
      agendaDateYmd: agenda || agenda_date,
      timeRaw: s.time,
    });
    if (!parsed) unparseableTimeCount += 1;

    let publicBookableForSlot = false;
    if (parsed?.isValid) {
      const local = parsed.setZone(PRIMETIME_BUSINESS_TIMEZONE);
      publicBookableForSlot = isPublicBookableMoment(local);
    }

    const labels: OpportunityAudienceLabels = parsed?.isValid
      ? labelsForMoment(parsed.setZone(PRIMETIME_BUSINESS_TIMEZONE))
      : {
          audience: "members",
          availabilityScope: "member_24_7",
          isPublicBookable: false,
          isMemberBookable: true,
        };

    return {
      ...s,
      parsed: parsed?.isValid ? parsed.setZone(PRIMETIME_BUSINESS_TIMEZONE) : null,
      publicBookableForSlot,
      labels,
      open: isSlotOpen(s),
      minuteOfDay: parsed?.isValid ? minuteOfDayFromDateTime(parsed) : null,
    };
  });

  const totalSlots = enriched.length;
  const totalCapacity = enriched.reduce((a, s) => a + Math.max(s.capacity ?? 1, 1), 0);
  const usedCapacity = enriched.reduce((a, s) => a + Math.max(s.used_capacity ?? 0, 0), 0);
  const utilizationPct = Math.round(
    (100 * usedCapacity) / Math.max(totalCapacity, 1)
  );

  const openSlotsRows = enriched.filter((s) => s.open);
  const openSlots = openSlotsRows.length;
  const bookedSlots = totalSlots - openSlots;

  const parseablePublicStrip = enriched.filter(
    (s) => s.parsed?.isValid && isPublicBookableMoment(s.parsed)
  );
  const publicHourCapacityDenom = parseablePublicStrip.reduce(
    (a, s) => a + Math.max(s.capacity ?? 1, 1),
    0
  );
  const publicHourUsedNumerator = parseablePublicStrip.reduce(
    (a, s) => a + Math.max(s.used_capacity ?? 0, 0),
    0
  );
  const publicUtilizationPct =
    publicHourCapacityDenom > 0
      ? Math.round((100 * publicHourUsedNumerator) / publicHourCapacityDenom)
      : null;

  const slotsOpenOutsidePublicHours = openSlotsRows.filter(
    (s) => !s.publicBookableForSlot
  ).length;
  const slotsOpenInsidePublicHours = openSlotsRows.filter((s) => s.publicBookableForSlot).length;

  const activeBookings = input.bookings.filter((b) => !b.deleted_at);
  const bookingCount = activeBookings.length;

  /** Group open slots by course + local hour */
  type BucketKey = string;
  const bucketMap = new Map<
    BucketKey,
    { hour: number; course_id: string | null; course_name: string | null; count: number }
  >();

  for (const s of openSlotsRows) {
    if (!s.parsed?.isValid) continue;
    const local = s.parsed;
    const cid = s.course_id ?? "__unknown";
    const key = `${cid}|${local.hour}`;
    const cur = bucketMap.get(key);
    const cname = s.course_name ?? null;
    if (cur) cur.count += 1;
    else
      bucketMap.set(key, {
        hour: local.hour,
        course_id: s.course_id,
        course_name: cname,
        count: 1,
      });
  }

  const slowWindows: SlowWindowItem[] = [];
  const unparsedOpenByCourse = new Map<
    string | null,
    { course_name: string | null; count: number }
  >();
  for (const s of openSlotsRows) {
    if (s.parsed?.isValid) continue;
    const k = s.course_id;
    const cur = unparsedOpenByCourse.get(k);
    if (!cur)
      unparsedOpenByCourse.set(k, {
        course_name: s.course_name ?? null,
        count: 1,
      });
    else cur.count += 1;
  }
  for (const [course_id, meta] of unparsedOpenByCourse) {
    if (meta.count < 3) continue;
    slowWindows.push({
      audience: "members",
      availabilityScope: "member_24_7",
      isPublicBookable: false,
      isMemberBookable: true,
      label: `${meta.course_name ?? course_id ?? "Bay"} — unparsed slot times (${meta.count} open)`,
      startTime: "—",
      endTime: "—",
      course_id,
      course_name: meta.course_name,
      openSlots: meta.count,
      reason: `${meta.count} open slots with times not parsed to ${PRIMETIME_BUSINESS_TIMEZONE} — excluded from public promos.`,
      suggestedAction:
        "Ops/member tooling only until times parse reliably; reinforce 24/7 member positioning if messaging at all.",
    });
  }

  for (const [, b] of bucketMap) {
    if (b.count < 3) continue;
    const start = DateTime.fromObject(
      {
        ...DateTime.fromISO(`${agenda_date}T00:00`, {
          zone: PRIMETIME_BUSINESS_TIMEZONE,
        }).toObject(),
        hour: b.hour,
        minute: 0,
      },
      { zone: PRIMETIME_BUSINESS_TIMEZONE }
    );
    const end = start.plus({ hours: 1 }).minus({ minutes: 1 });
    const aud = hourBucketAudience(b.hour, agenda_date);

    const isPublicAudience = aud.audience === "public";

    slowWindows.push({
      ...aud,
      label: `${b.course_name ?? b.course_id ?? "Bay"} ${start.toFormat("h:mm a")}–${end.toFormat("h:mm a")}`,
      startTime: start.toFormat("HH:mm"),
      endTime: end.toFormat("HH:mm"),
      course_id: b.course_id,
      course_name: b.course_name,
      openSlots: b.count,
      reason: `${b.count} consecutive open bays in one hour`,
      suggestedAction: isPublicAudience
        ? "Promote same-day simulator bookings, lesson upsell, or public events messaging."
        : "Member-only framing: practice access and 24/7 membership benefits — do not blast public promos.",
    });
  }

  slowWindows.sort((a, b) => {
    if (a.startTime === "—" && b.startTime !== "—") return 1;
    if (b.startTime === "—" && a.startTime !== "—") return -1;
    const cn = (a.course_name ?? "").localeCompare(b.course_name ?? "");
    if (cn !== 0) return cn;
    return a.startTime.localeCompare(b.startTime);
  });

  const bookingByCourse = new Map<string | null, number>();
  for (const b of activeBookings) {
    bookingByCourse.set(
      b.course_id,
      (bookingByCourse.get(b.course_id) ?? 0) + 1
    );
  }

  const courses = new Map<
    string,
    {
      course_id: string | null;
      course_name: string | null;
      slots: EnrichedSlot[];
    }
  >();

  for (const s of enriched) {
    const ck = s.course_id ?? "__unknown";
    let g = courses.get(ck);
    if (!g) {
      g = { course_id: s.course_id, course_name: s.course_name ?? null, slots: [] };
      courses.set(ck, g);
    }
    g.slots.push(s);
  }

  const byCourse: ByCourseAgg[] = [];
  for (const [, g] of courses) {
    const ts = g.slots.length;
    const open = g.slots.filter((x) => x.open).length;
    const bk = ts - open;
    const tc = g.slots.reduce((a, s) => a + Math.max(s.capacity ?? 1, 1), 0);
    const uc = g.slots.reduce((a, s) => a + Math.max(s.used_capacity ?? 0, 0), 0);
    const util = Math.round((100 * uc) / Math.max(tc, 1));

    const pubSlots = g.slots.filter((s) => s.parsed?.isValid && isPublicBookableMoment(s.parsed));
    let aud: OpportunityAudienceLabels;
    if (pubSlots.some((s) => s.publicBookableForSlot && s.open)) {
      aud = {
        audience: "public",
        availabilityScope: "public_hours",
        isPublicBookable: true,
        isMemberBookable: true,
      };
    } else if (open > 0) {
      aud = {
        audience: "members",
        availabilityScope: "member_24_7",
        isPublicBookable: false,
        isMemberBookable: true,
      };
    } else {
      aud = {
        audience: "members",
        availabilityScope: "member_24_7",
        isPublicBookable: false,
        isMemberBookable: false,
      };
    }

    byCourse.push({
      ...aud,
      course_id: g.course_id,
      course_name: g.course_name,
      totalSlots: ts,
      bookedSlots: bk,
      openSlots: open,
      utilizationPct: util,
      totalCapacity: tc,
      usedCapacity: uc,
    });
  }

  byCourse.sort((a, b) => (b.openSlots ?? 0) - (a.openSlots ?? 0));

  const opportunities: OpportunityItem[] = [];

  /** low_utilization_day — PUBLIC */
  if (
    publicUtilizationPct !== null &&
    publicUtilizationPct < 40 &&
    publicHourCapacityDenom > 0
  ) {
    opportunities.push({
      type: "low_utilization_day",
      priority: "high",
      audience: "public",
      availabilityScope: "public_hours",
      isPublicBookable: true,
      isMemberBookable: true,
      title: "Public hours utilization is below target",
      reason: `Public-hours capacity-weighted fill is ${publicUtilizationPct}% (below 40%).`,
      suggestedAction:
        "Run targeted reactivation, same-day booking push, lesson bundles, or public events during Wed–Sun 11 AM–9 PM LA.",
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  /** low_utilization_day — MEMBERS when overall fill is low and slack is mostly outside public hours */
  if (
    utilizationPct < 40 &&
    slotsOpenOutsidePublicHours > slotsOpenInsidePublicHours
  ) {
    opportunities.push({
      type: "low_utilization_day",
      priority: "high",
      audience: "members",
      availabilityScope: "member_24_7",
      isPublicBookable: false,
      isMemberBookable: true,
      title: "Facility slack concentrated outside public-bookable hours",
      reason: `Overall utilization is ${utilizationPct}%; more open inventory sits outside Wed–Sun 11 AM–9 PM LA (${slotsOpenOutsidePublicHours} open outside vs ${slotsOpenInsidePublicHours} inside public hours).`,
      suggestedAction:
        "Promote member practice access, reinforce 24/7 member benefit, lifecycle upsell or retention-focused engagement — not general public promotions.",
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  /** open_bay_window from slowWindows */
  for (const sw of slowWindows) {
    opportunities.push({
      type: "open_bay_window",
      priority: sw.audience === "public" ? "medium" : "normal",
      audience: sw.audience,
      availabilityScope: sw.availabilityScope,
      isPublicBookable: sw.isPublicBookable,
      isMemberBookable: sw.isMemberBookable,
      title:
        sw.audience === "public"
          ? "Open bay window (public-bookable)"
          : "Open bay window (member hours)",
      reason: sw.reason,
      suggestedAction: sw.suggestedAction,
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  const openPrime = enriched.filter((s) => {
    if (!s.open || s.minuteOfDay === null || !s.parsed?.isValid) return false;
    const m = s.minuteOfDay;
    return m >= 16 * 60 && m < 20 * 60;
  });
  if (openPrime.length > 0) {
    const anyPublic = openPrime.some((s) => s.publicBookableForSlot);
    opportunities.push({
      type: "prime_time_gap",
      priority: anyPublic ? "high" : "medium",
      audience: anyPublic ? "public" : "members",
      availabilityScope: anyPublic ? "public_hours" : "member_24_7",
      isPublicBookable: anyPublic,
      isMemberBookable: true,
      title: anyPublic ? "Prime evening windows still have open bays" : "Prime evening inventory (member context)",
      reason: `${openPrime.length} open slots observed between roughly 4–8 PM local.`,
      suggestedAction: anyPublic
        ? "Push after-work public simulator availability and bundles."
        : "Member-only framing: highlight evening member access perks or facility exclusivity.",
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  const middayOpen = enriched.filter(
    (s) =>
      s.open &&
      s.publicBookableForSlot &&
      s.minuteOfDay !== null &&
      s.minuteOfDay >= 11 * 60 &&
      s.minuteOfDay < 16 * 60
  );
  const afterPublicCloseOpen = enriched.filter(
    (s) =>
      s.open &&
      s.parsed?.isValid &&
      isPublicCalendarDay(s.parsed.weekday) &&
      s.minuteOfDay !== null &&
      s.minuteOfDay > PUBLIC_END_MINUTE
  );
  const morningMemberOpen = enriched.filter(
    (s) =>
      s.open &&
      s.parsed?.isValid &&
      isPublicCalendarDay(s.parsed.weekday) &&
      s.minuteOfDay !== null &&
      s.minuteOfDay < 11 * 60
  );
  const monTueOpen = enriched.filter((s) => s.open && s.parsed?.isValid && !isPublicCalendarDay(s.parsed.weekday));

  if (middayOpen.length > 0) {
    opportunities.push({
      type: "morning_or_midday_gap",
      priority: "medium",
      audience: "public",
      availabilityScope: "public_hours",
      isPublicBookable: true,
      isMemberBookable: true,
      title: "Mid-day public-hours availability",
      reason: `${middayOpen.length} open slots Wednesday–Sunday between 11 AM and 4 PM LA.`,
      suggestedAction:
        "Target remote workers, retirees, lesson leads, and daytime practice bundles during public-access hours.",
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  if (morningMemberOpen.length > 0) {
    opportunities.push({
      type: "morning_or_midday_gap",
      priority: "normal",
      audience: "members",
      availabilityScope: "member_24_7",
      isPublicBookable: false,
      isMemberBookable: true,
      title: "Pre–11 AM bays open on public calendar days",
      reason: `${morningMemberOpen.length} slots before public non-member opening (member-only outreach).`,
      suggestedAction:
        "Member framing: sunrise practice perks, memberships, upgrades — avoid public-facing promos here.",
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  if (afterPublicCloseOpen.length > 0) {
    opportunities.push({
      type: "after_public_hours_member",
      priority: "normal",
      audience: "members",
      availabilityScope: "member_24_7",
      isPublicBookable: false,
      isMemberBookable: true,
      title: "Post–9 PM bays open (member audience)",
      reason: `${afterPublicCloseOpen.length} open slot starts after 9:00 PM LA on Wed–Sun (outside public non-member bookable window).`,
      suggestedAction:
        "Member-only 24/7 value story, late practice access, retention — never position as walk-in public promos.",
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  if (monTueOpen.length > 0) {
    opportunities.push({
      type: "morning_or_midday_gap",
      priority: "normal",
      audience: "members",
      availabilityScope: "member_24_7",
      isPublicBookable: false,
      isMemberBookable: true,
      title: "Monday/Tuesday bays available",
      reason: `${monTueOpen.length} open simulator slots outside public weekday access.`,
      suggestedAction:
        "Member-only availability story: practice lanes, dues value, concierge upgrade offers — never market as general public openings.",
      estimatedValueLabel: EST_VALUE_OPS,
      source: "whoosh_agenda_slots",
    });
  }

  /** booking_density_signal */
  if (bookingByCourse.size >= 2) {
    let maxC: string | null = null;
    let minC: string | null = null;
    let maxV = -1;
    let minV = Infinity;
    for (const [k, v] of bookingByCourse) {
      if (v > maxV) {
        maxV = v;
        maxC = k;
      }
      if (v < minV) {
        minV = v;
        minC = k;
      }
    }
    if (maxC !== minC && maxV - minV >= 2) {
      const wedSun = DateTime.fromISO(`${agenda_date}T12:00`, {
        zone: PRIMETIME_BUSINESS_TIMEZONE,
      }).weekday >= 3;
      opportunities.push({
        type: "booking_density_signal",
        priority: "medium",
        audience: wedSun ? "public" : "members",
        availabilityScope: wedSun ? "public_hours" : "member_24_7",
        isPublicBookable: wedSun,
        isMemberBookable: true,
        title: "Uneven simulator booking concentration",
        reason: `Bookings diverge across courses (${maxV} vs ${Math.round(minV)} active rows).`,
        suggestedAction: wedSun
          ? "Rebalance daylight marketing toward the under-used public-access bay/time."
          : "Member-heavy week: reposition traffic to lighter bays via member comms.",
        estimatedValueLabel: EST_VALUE_OPS,
        source: "whoosh_agenda_bookings",
      });
    }
  }

  return {
    ok: true,
    agenda_date,
    facility_slug,
    businessHours: PRIMETIME_OPPORTUNITY_BUSINESS_HOURS,
    summary: {
      totalSlots,
      totalBookings: bookingCount,
      bookingCount,
      openSlots,
      bookedSlots,
      utilizationPct,
      publicUtilizationPct,
      slotsOpenOutsidePublicHours,
      slotsOpenInsidePublicHours,
      unparseableTimeCount,
      totalCapacity,
      usedCapacity,
      publicHourCapacityDenom,
      publicHourUsedNumerator,
    },
    byCourse,
    slowWindows,
    opportunities,
  };
}
