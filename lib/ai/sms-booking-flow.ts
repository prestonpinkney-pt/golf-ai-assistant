import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

import { type ConversationHistoryMessage } from "@/lib/ai/conversation-reply-core";
import { isLikelyE164Phone } from "@/lib/ai/phone-e164";
import {
  BOOKING_CONFIRMATION_HANDOFF_REPLY,
} from "@/lib/ai/booking-outbound-guard";
import { logMessagingAudit } from "@/lib/messaging/audit";
import {
  closeOsSimulatorHoldExpirationMinutes,
  isCloseOsNonMemberSimulatorPaymentHoldEnabled,
} from "@/lib/closeos/booking-hold-config";
import {
  hasActiveSimulatorHoldConflict,
  insertCloseOsBookingHold,
  pickSlotCorrelationIds,
  updateCloseOsBookingPaymentFields,
} from "@/lib/closeos/booking-hold-repo";
import {
  PAY_HOLD_TITLE,
  buildCloseOsSimulatorPaymentHoldOutboundSms,
  buildPaymentHoldSquareDescriptionNote,
} from "@/lib/closeos/sms-hold-copy";
import {
  compactPricingSmsForBayQuestion,
  isLikelyLessonPricingQuestion,
  isLikelyStandalonePricingQuestion,
  lessonPricingSentence,
  PRIMETIME_LOCATION_LINE,
  PRIMETIME_WEBSITE,
} from "@/lib/primetime/pricing";
import { estimateSimulatorBookingUsdCents } from "@/lib/primetime/simulator-quote";
import { createSquareSimulatorBayBookingPaymentLink } from "@/lib/square/create-checkout-payment-link";
import {
  getWhooshAvailability,
  type NormalizedWhooshAvailabilitySlot,
  type WhooshAvailabilityParams,
  type WhooshServiceType,
} from "@/lib/whoosh/availability";
import {
  buildWhooshIntegrationBookingWire,
  createWhooshBooking,
  getWhooshBookingCreateEnvDiagnostics,
  resolveWhooshBookingMemberNumber,
  whooshIntegrationRequestPersistSummary,
  type WhooshBookingCreateParams,
} from "@/lib/whoosh/bookings";

const ISO_DATE = /\b(20\d{2}-\d{2}-\d{2})\b/;
const BUSINESS_TIMEZONE = "America/Los_Angeles";

export type SmsBookingDateSource =
  | "explicit_weekday"
  | "explicit_date"
  | "stored_context"
  | "fallback";

/** Pacific human label for outbound SMS referencing a slot ISO instant. */
function formatPacSlotDisplayHuman(isoStart: string): string {
  const startShow = DateTime.fromISO(isoStart, { zone: "utc" }).setZone("America/Los_Angeles");
  return startShow.isValid ? startShow.toFormat("h:mm a ccc LLL d") : "that time";
}

/** JSON-safe slot snapshot persisted on CloseOS bookings for webhook replay. */
function jsonSnapshotForCloseOsBookingSlot(slot: NormalizedWhooshAvailabilitySlot): Record<string, unknown> {
  return {
    startTime: slot.startTime,
    endTime: slot.endTime,
    bayOrResourceId: slot.bayOrResourceId,
    resourceName: slot.resourceName,
    serviceType: slot.serviceType,
    priceEstimate: slot.priceEstimate,
    raw:
      slot.raw !== null &&
      typeof slot.raw === "object" &&
      !Array.isArray(slot.raw) ?
        (slot.raw as Record<string, unknown>)
      : {},
  };
}

/** Safe DB payload fragment for integration errors (never logs verbatim secrets). */
function summarizeWhooshErrorRawForBookingActions(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw.slice(0, 800);
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {
      keys: Object.keys(o).slice(0, 48),
    };
    const topMsg =
      typeof o.message === "string" && o.message.trim() ? o.message.trim()
      : typeof o.error === "string" && o.error.trim() ? o.error.trim()
      : "";
    if (topMsg) out.top_level_message = topMsg.slice(0, 400);

    const errs = o.errors;
    if (Array.isArray(errs) && errs.length) {
      out.errors_preview = errs.slice(0, 10).map((e: unknown) => {
        if (e === null || typeof e !== "object" || Array.isArray(e)) {
          return { detail: typeof e === "string" ? e.slice(0, 400) : String(e) };
        }
        const row = e as Record<string, unknown>;
        const src = row.source;
        let pointer: string | null = null;
        if (src !== null && typeof src === "object" && !Array.isArray(src)) {
          const p = (src as Record<string, unknown>).pointer;
          if (typeof p === "string" && p.trim()) pointer = p.trim().slice(0, 160);
        }
        const field =
          typeof row.field === "string" && row.field.trim() ?
            row.field.trim().slice(0, 160)
          : pointer;
        const title =
          typeof row.title === "string" && row.title.trim() ?
            row.title.trim().slice(0, 200)
          : null;
        const detail =
          typeof row.detail === "string" && row.detail.trim() ?
            row.detail.trim().slice(0, 500)
          : null;
        return { title, field, detail };
      });
    }

    const dataKeys =
      o.data !== null && typeof o.data === "object" && !Array.isArray(o.data) ?
        Object.keys(o.data as object).slice(0, 20)
      : null;
    if (dataKeys && dataKeys.length) out.data_keys = dataKeys;

    return out;
  }
  return typeof raw;
}

/** Injected at runtime for isolated tests (`sms-booking-flow.test.ts`). */
export const whooshAvailabilityClient = {
  getAvailability: (p: WhooshAvailabilityParams) => getWhooshAvailability(p),
};

export const whooshBookingClient = {
  createBooking: (p: WhooshBookingCreateParams) => createWhooshBooking(p),
};

/** Injected checkout link creator (`sms-booking-flow.test.ts` stubs failures). */
export const squarePaymentHoldCheckoutClient = {
  createBookingHoldCheckoutLink: (args: Parameters<typeof createSquareSimulatorBayBookingPaymentLink>[0]) =>
    createSquareSimulatorBayBookingPaymentLink(args),
};

export type SmsBookingIntent =
  | "pricing"
  | "availability_lookup"
  | "booking_create"
  | "missing_details"
  | "none";

export type SmsBookingSlotSource = "whoosh" | "inferred" | "none";

export type SmsBookingFlowDebug = {
  intent: SmsBookingIntent;
  whooshAvailabilityAttempted: boolean;
  whooshBookingAttempted: boolean;
  whooshBookingConfirmed: boolean;
  /** True when simulator bay duration came from Primetime/default config, not the transcript. */
  durationDefaulted: boolean;
  requiredDetailsMissing: string[];
  selectedSlotSource: SmsBookingSlotSource;
  reason: string;
  /** Offer reuse / staleness instrumentation (stored `booking_actions` availability rows). */
  latestInboundIsNewBookingRequest?: boolean;
  latestInboundIsSlotPick?: boolean;
  usingStoredOfferSlots?: boolean;
  foundStoredOffer?: boolean;
  storedOfferRejectedReason?: string | null;
  contactMatch?: boolean | null;
  conversationMatch?: boolean | null;
  requestedDateMatch?: boolean | null;
  offerAgeSeconds?: number | null;
  freshLookupReason?: string | null;
  inbound_text?: string;
  resolved_requested_date?: string | null;
  date_source?: SmsBookingDateSource;
  timezone?: string;
};

export type BookingFlowAugmentation =
  | { kind: "none"; debug: SmsBookingFlowDebug }
  | { kind: "appendix"; text: string; debug: SmsBookingFlowDebug }
  | {
      kind: "direct_outbound";
      replyText: string;
      bypassRiskyResponseGuard?: boolean;
      extraMetadata?: Record<string, unknown>;
      /** Only true immediately after Whoosh POST booking returns ok:true (route sets outbound guard). */
      bookingConfirmedByWhoosh?: boolean;
      debug: SmsBookingFlowDebug;
    };

export type BookingFacts = {
  serviceType: WhooshServiceType;
  isoDate: string | null;
  partySize: number | null;
  preferredTimePhrase: string | null;
  simulatorDurationMinutes: number | null;
  lessonTrack: "adult" | "junior" | null;
  lessonDurationMinutes: 30 | 60 | null;
};

function containsBookingCue(text: string): boolean {
  return /\b(book|booking|reserve|reservation|hold|availability|available|schedule|calendar|bay time)\b/i.test(
    text
  );
}

function mergeTranscript(history: ConversationHistoryMessage[], inbound: string): string {
  return [...history.map((m) => m.message_text ?? ""), inbound].join("\n").trim().slice(-8000);
}

export function inferServiceType(playbook: string): WhooshServiceType {
  if (playbook === "lesson") return "lesson";
  if (playbook === "event") return "event";
  return "simulator";
}

const PARTY_WORD_TO_N: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const DURATION_WORD_TO_HOURS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

export function extractPartySize(fullText: string): number | null {
  const lower = fullText.toLowerCase();
  if (/\bjust me\b|\bsolo\b|\bmyself\b|\bone player\b|\b1 player\b/.test(lower)) return 1;
  if (/\bsolo\b\s*(practice)?\s*session\b/.test(lower)) return 1;

  const wordParty =
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:players?|people|person|ppl)\b/i.exec(
      lower
    );
  if (wordParty?.[1]) {
    const n = PARTY_WORD_TO_N[wordParty[1]];
    if (n) return Math.min(Math.max(n, 1), 32);
  }

  const partyOfWord =
    /\bparty of\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.exec(lower);
  if (partyOfWord?.[1]) {
    const n = PARTY_WORD_TO_N[partyOfWord[1]];
    if (n) return Math.min(Math.max(n, 1), 32);
  }

  const m =
    /\b(\d{1,2})\s*(players|player|people|person|ppl)\b/i.exec(fullText) ||
    /\bparty of\s*(\d{1,2})\b/i.exec(fullText) ||
    /\b(\d{1,2})\s*ppl\b/i.exec(fullText);

  if (!m) return null;

  const num = Number(m[1]);
  return Number.isFinite(num) ? Math.min(Math.max(Math.round(num), 1), 32) : null;
}

export function extractLessonTrack(fullText: string): BookingFacts["lessonTrack"] {
  if (/\bjunior\b|\bkids?\b|\bchild\b|\bminor\b/i.test(fullText)) return "junior";
  if (/\badult\b|\bgrown\b|\bmyself\b/i.test(fullText)) return "adult";
  return null;
}

export function extractLessonDuration(fullText: string): 30 | 60 | null {
  const t = fullText.toLowerCase();

  if (/\b30\b|\bhalf\s*-?\s*hour\b|\bhalf\b(?!\w)/i.test(t)) return 30;
  if (/\b60\b|\b1\s*-?\s*hour\b|\bfull\s*-?\s*hour\b|\bhour\b/i.test(t) || /\ban hour\b/i.test(t))
    return 60;

  return null;
}

/** Prefer explicit clock (last mention wins) over coarse morning/afternoon/evening. */
export function extractLastExplicitClockPhrase(fullText: string): string | null {
  const clockRe = /\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)\b/gi;
  let last: string | null = null;
  let m;
  while ((m = clockRe.exec(fullText)) !== null) {
    last = m[0].trim();
  }
  return last;
}

export function extractPreferredTimePhrase(fullText: string): string | null {
  const explicit = extractLastExplicitClockPhrase(fullText);
  if (explicit) return explicit;

  const t = fullText.toLowerCase();
  if (/\bmorning\b/.test(t)) return "morning";
  if (/\bafternoon\b/.test(t)) return "afternoon";
  if (/\bevening\b|\bafter\s*work\b|\blater\b|\btonight\b/.test(t)) return "evening";

  const tod = /\b(\d{1,2})\s*:?\s*(\d{2})\s*(am|pm)\b/i.exec(t);
  if (tod?.[0]) return tod[0].trim();

  return null;
}

/**
 * Resolved simulator bay duration for Whoosh browsing and precheck skip rules.
 * `defaultMinutes=null` skips defaulting (customer must specify duration explicitly).
 */
export function resolveSimulatorBayDurationMinutes(
  facts: BookingFacts,
  defaultMinutes: number | null
): { minutes: number | null; defaulted: boolean } {
  if (facts.serviceType !== "simulator") {
    return {
      minutes: facts.simulatorDurationMinutes,
      defaulted: false,
    };
  }

  if (facts.simulatorDurationMinutes != null) {
    return { minutes: facts.simulatorDurationMinutes, defaulted: false };
  }

  if (
    typeof defaultMinutes === "number" &&
    Number.isFinite(defaultMinutes) &&
    defaultMinutes > 0
  ) {
    const capped = Math.min(Math.max(Math.round(defaultMinutes), 15), 12 * 60);
    return { minutes: capped, defaulted: true };
  }

  return { minutes: null, defaulted: false };
}

/** Env `SMS_SIMULATOR_BAY_DEFAULT_DURATION_MINUTES`: unset→60; 0|false|none|off→no default (require explicit duration). */
function readSimulatorBayDefaultDurationMinutesFromEnv(): number | null {
  const raw = process.env.SMS_SIMULATOR_BAY_DEFAULT_DURATION_MINUTES?.trim().toLowerCase();
  if (!raw || raw === "") return 60;
  if (["0", "none", "off", "false", "explicit"].includes(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 60;
}

export function extractSimulatorDurationMinutes(fullText: string): number | null {
  const matches: Array<{ index: number; minutes: number }> = [];

  const push = (index: number, minutes: number) => {
    if (Number.isFinite(minutes)) matches.push({ index, minutes: Math.min(Math.max(Math.round(minutes), 15), 720) });
  };

  for (const m of fullText.matchAll(/\b(\d{1,2})\s*(?:hours?|hrs?|hr)\b/gi)) {
    const h = Number(m[1]);
    if (Number.isFinite(h)) push(m.index ?? 0, h * 60);
  }

  for (const m of fullText.matchAll(/\b(one|two|three|four|five|six)\s*(?:hours?|hrs?|hr)\b/gi)) {
    const h = DURATION_WORD_TO_HOURS[m[1]?.toLowerCase() ?? ""];
    if (h) push(m.index ?? 0, h * 60);
  }

  for (const m of fullText.matchAll(/\b(\d{2,3})\s*(?:minutes?|mins?|min)\b/gi)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) push(m.index ?? 0, n);
  }

  for (const m of fullText.matchAll(/\bone\s+(?:and\s+a\s+)?half\s*(?:hours?|hrs?|hr)\b/gi)) {
    push(m.index ?? 0, 90);
  }

  for (const m of fullText.matchAll(/\bhalf\s*-?\s*hour\b/gi)) {
    push(m.index ?? 0, 30);
  }

  for (const m of fullText.matchAll(/\b(?:a|an)\s+(?:full\s+)?hour\b|\bhourly\b/gi)) {
    push(m.index ?? 0, 60);
  }

  matches.sort((a, b) => a.index - b.index);
  return matches.at(-1)?.minutes ?? null;
}

export function resolveRequestedDateFromText(
  subject: string,
  anchor: DateTime,
  timezone = BUSINESS_TIMEZONE
): { isoDate: string | null; source: SmsBookingDateSource } {
  const lowered = subject.toLowerCase();
  const local = anchor.setZone(timezone).startOf("day");

  const direct = subject.match(ISO_DATE);
  if (direct?.[1]) return { isoDate: direct[1], source: "explicit_date" };

  if (/\btoday\b/i.test(lowered)) return { isoDate: local.toISODate(), source: "explicit_date" };
  if (/\btomorrow\b/i.test(lowered)) {
    return { isoDate: local.plus({ days: 1 }).toISODate(), source: "explicit_date" };
  }

  const mmdd = /\b(\d{1,2})\/(\d{1,2})\b/.exec(lowered);
  if (mmdd?.[1] && mmdd[2]) {
    const dt = local.set({
      month: Number(mmdd[1]),
      day: Number(mmdd[2]),
    });
    return { isoDate: dt.isValid ? dt.toISODate() : null, source: "explicit_date" };
  }

  const weekdayMap: Record<string, number> = {
    monday: 1,
    mon: 1,
    tuesday: 2,
    tues: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thurs: 4,
    thur: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
    sunday: 7,
    sun: 7,
  };
  const weekdayRe =
    /\b(?:(this|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)\b/gi;
  let weekdayMatch: { modifier: string | null; dow: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = weekdayRe.exec(subject)) !== null) {
    const dow = weekdayMap[m[2]?.toLowerCase() ?? ""];
    if (!dow) continue;
    let modifier = m[1]?.toLowerCase() ?? null;
    // "Friday next week" / "Friday of next week" — not "next weekend"
    const after = subject.slice((m.index ?? 0) + m[0].length);
    if (/^\s+(?:of\s+)?next\s+week\b(?!end)/i.test(after)) modifier = "next";
    // "next week Friday" / "next week on Friday" / "next week's Friday"
    const before = subject.slice(0, m.index ?? 0);
    if (/\bnext\s+week(?:'s)?(?:\s+on)?\s+$/i.test(before)) modifier = "next";
    weekdayMatch = { modifier, dow };
  }
  if (weekdayMatch) {
    const baseDelta = (weekdayMatch.dow - local.weekday + 7) % 7;
    const days =
      weekdayMatch.modifier === "next" ? baseDelta + 7 : baseDelta;
    return {
      isoDate: local.plus({ days }).toISODate(),
      source: "explicit_weekday",
    };
  }

  return { isoDate: null, source: "fallback" };
}

export function resolveIsoDateFromTranscript(subject: string, anchor: DateTime): string | null {
  return resolveRequestedDateFromText(subject, anchor).isoDate;
}

function collectBookingFactsWithDateResolution(
  playbook: string,
  transcript: string,
  latestInboundText: string,
  anchorLA: DateTime
): { facts: BookingFacts; dateResolution: { isoDate: string | null; source: SmsBookingDateSource } } {
  const serviceType = inferServiceType(playbook);
  const latestInboundDate = resolveRequestedDateFromText(latestInboundText, anchorLA);
  const contextDate =
    latestInboundDate.isoDate ? latestInboundDate : resolveRequestedDateFromText(transcript, anchorLA);
  const dateResolution =
    latestInboundDate.isoDate ? latestInboundDate :
    contextDate.isoDate ? { isoDate: contextDate.isoDate, source: "stored_context" as const }
    : contextDate;

  return {
    facts: {
      serviceType,
      isoDate: dateResolution.isoDate,
      partySize: extractPartySize(transcript),
      preferredTimePhrase: extractPreferredTimePhrase(transcript),
      simulatorDurationMinutes:
        serviceType === "lesson" ? null :
          extractSimulatorDurationMinutes(latestInboundText) ??
          extractSimulatorDurationMinutes(transcript),
      lessonTrack: extractLessonTrack(transcript),
      lessonDurationMinutes: extractLessonDuration(transcript),
    },
    dateResolution,
  };
}

export function collectBookingFacts(playbook: string, transcript: string, anchorLA: DateTime): BookingFacts {
  return collectBookingFactsWithDateResolution(playbook, transcript, transcript, anchorLA).facts;
}

function missingFactsForLesson(
  facts: BookingFacts,
  contactPhone: string | null | undefined
): string[] {
  const needs: string[] = [];
  if (!facts.isoDate) needs.push("date");
  if (!facts.lessonTrack) needs.push("adult_or_junior");
  if (!facts.lessonDurationMinutes) needs.push("session_length_minutes");
  if (!facts.preferredTimePhrase) needs.push("time_preference_window");
  if (!isLikelyE164Phone(contactPhone)) needs.push("customer_phone");
  return needs;
}

function simulatorLookupMissingFields(
  facts: BookingFacts,
  contactPhone: string | null | undefined,
  simulatorDurationResolved: number | null
): string[] {
  if (facts.serviceType !== "simulator") return [];
  const needs: string[] = [];
  if (!facts.isoDate) needs.push("date");
  if (!facts.partySize) needs.push("player_count");
  if (simulatorDurationResolved == null) needs.push("duration_minutes");
  if (!facts.preferredTimePhrase) needs.push("time_range");
  if (!isLikelyE164Phone(contactPhone)) needs.push("customer_phone");
  return needs;
}

function smsInactiveDebug(reason: string): SmsBookingFlowDebug {
  return {
    intent: "none",
    whooshAvailabilityAttempted: false,
    whooshBookingAttempted: false,
    whooshBookingConfirmed: false,
    durationDefaulted: false,
    requiredDetailsMissing: [],
    selectedSlotSource: "none",
    reason,
  };
}

/** Dev-only hints; messages must match product copy for config triage. */
function logWhooshSmsBookingCreateConfigConsole(opts: {
  env: ReturnType<typeof getWhooshBookingCreateEnvDiagnostics>;
  bayOrResourceId: string;
}): void {
  const { env } = opts;
  const bay = opts.bayOrResourceId.trim();
  if (!env.bookingApiEnabled) {
    console.warn("WHOOSH_BOOKING_API_ENABLED missing/false");
  }
  if (!env.bookingPostPathPresent) {
    console.warn("WHOOSH_BOOKING_POST_PATH missing");
  }
  if (!bay || bay.toLowerCase().startsWith("composer:")) {
    console.warn("selected slot missing bayOrResourceId");
  }
  if (!env.whooshApiBaseUrlPresent || !env.whooshApiTokenPresent) {
    console.warn("Whoosh API base/token missing");
  }
}

async function emitSmsBookingAudit(
  supabase: SupabaseClient,
  conversationId: string | null | undefined,
  businessId: string | null | undefined,
  eventType: string,
  metadata: Record<string, unknown>
) {
  if (!conversationId) return;
  await logMessagingAudit(supabase, {
    entity_type: "conversation",
    entity_id: conversationId,
    event_type: eventType,
    metadata: {
      ...metadata,
      business_id: businessId ?? null,
    },
  });
}

export function summarizeMissingQuestions(
  missing: string[],
  facts: BookingFacts,
  transcriptHint?: string
): string[] {
  if (facts.serviceType === "lesson") {
    return missing.map((m) => {
      switch (m) {
        case "date":
          return "Confirm which precise day you'd like.";
        case "adult_or_junior":
          return "Say adult or junior so we grab the correct lesson SKU.";
        case "session_length_minutes":
          return "Prefer 30 or 60 minutes today?";
        case "time_preference_window":
          return "Morning, afternoon, or evening work better that day?";
        case "customer_phone":
          return "Is texting this SMS number okay for confirmations? Reply YES.";
        default:
          return m;
      }
    });
  }

  return missing.map((m) => {
    switch (m) {
      case "date":
        return "What exact calendar day fits?";
      case "player_count":
        return "How many players total?";
      case "duration_minutes":
        return extractLastExplicitClockPhrase(transcriptHint ?? "")
          ? "Got it — roughly how long would you like the bay for?"
          : "Roughly how long would you like the bay — 30 minutes, 1 hour, or 2 hours?";
      case "time_range":
        return "Morning, afternoon, or evening?";
      case "customer_phone":
        return "Is texting this SMS number okay for confirmations? Reply YES.";
      case "numeric_slot_choice":
        return "Reply using 1, 2, or 3 matching the numbered openings.";
      default:
        return m;
    }
  });
}

export function createSmsBookingNoneAugmentation(reason: string): BookingFlowAugmentation {
  return { kind: "none", debug: smsInactiveDebug(reason) };
}

/** Persisted outbound `metadata.sms_booking_flow` envelope (parity: ai/respond + Sent.dm inbound loop). */
export function buildSmsBookingFlowMetadataRecord(
  flow: BookingFlowAugmentation
): Record<string, unknown> {
  if (flow.kind === "none") {
    return { mode: flow.kind, ...flow.debug };
  }
  if (flow.kind === "appendix") {
    const preview =
      flow.text.length > 220 ? `${flow.text.slice(0, 220).trimEnd()}…` : flow.text;
    return {
      mode: flow.kind,
      appendix_preview: preview,
      ...flow.debug,
    };
  }
  return {
    mode: flow.kind,
    ...(flow.extraMetadata ?? {}),
    ...flow.debug,
    booking_confirmed_by_whoosh_gate: !!flow.bookingConfirmedByWhoosh,
    bypass_risky_guard: !!flow.bypassRiskyResponseGuard,
  };
}

function isBookingActionsPersistenceLikelyUnavailable(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /booking_actions/.test(m) &&
    (/schema cache/.test(m) ||
      /could not find/.test(m) ||
      /\bpgrst\b/.test(m) ||
      /does not exist/.test(m) ||
      /\b42p01\b/.test(m) ||
      /relation\s+[^\s]+\s+does\s+not\s+exist/.test(m))
  );
}

async function persistBookingAction(params: {
  supabase: SupabaseClient;
  businessId: string;
  conversationId: string | null;
  contactId: string | null;
  actionType: "availability_lookup" | "booking_create";
  status: "pending" | "completed" | "failed";
  serviceType?: string | null;
  requestedDateIso?: string | null;
  requestedTimeRange?: string | null;
  partySize?: number | null;
  durationMinutes?: number | null;
  selectedStart?: string | null;
  selectedEnd?: string | null;
  providerBookingId?: string | null;
  providerRequestId?: string | null;
  errorMessage?: string | null;
  payload: Record<string, unknown>;
}): Promise<{ ok: boolean; errorMessage: string | null }> {
  const { error } = await params.supabase.from("booking_actions").insert({
    business_id: params.businessId,
    conversation_id: params.conversationId,
    contact_id: params.contactId,
    provider: "whoosh",
    action_type: params.actionType,
    status: params.status,
    service_type: params.serviceType ?? null,
    requested_date: params.requestedDateIso ?? null,
    requested_time_range: params.requestedTimeRange ?? null,
    party_size: params.partySize ?? null,
    duration_minutes: params.durationMinutes ?? null,
    selected_start_time: params.selectedStart ?? null,
    selected_end_time: params.selectedEnd ?? null,
    provider_booking_id: params.providerBookingId ?? null,
    provider_request_id: params.providerRequestId ?? null,
    error_message: params.errorMessage ?? null,
    raw_payload: params.payload,
    updated_at: new Date().toISOString(),
  });

  if (error?.message) {
    const msg = error.message;
    console.error("[sms-booking-flow] booking_actions INSERT failed:", msg);
    if (isBookingActionsPersistenceLikelyUnavailable(msg)) {
      console.error(
        "[sms-booking-flow] Apply migration supabase/migrations/20260514120000_booking_actions.sql then NOTIFY pgrst reload schema."
      );
    }
    return { ok: false, errorMessage: msg };
  }

  return { ok: true, errorMessage: null };
}

/** Stored snapshot for SMS slot UX (indexed 1–3 + fields required for booking create). */
export type StoredOfferedSlotWire = {
  option_index: number;
  startTime: string;
  endTime: string;
  bayOrResourceId: string;
  resourceName: string | null;
  priceEstimate: string | null;
  serviceType: WhooshServiceType;
  raw: Record<string, unknown>;
};

function buildStoredOfferSlots(offeredSlots: NormalizedWhooshAvailabilitySlot[]): StoredOfferedSlotWire[] {
  return offeredSlots.map((slot, i) => ({
    option_index: i + 1,
    startTime: slot.startTime,
    endTime: slot.endTime,
    bayOrResourceId: slot.bayOrResourceId,
    resourceName: slot.resourceName ?? null,
    priceEstimate: slot.priceEstimate ?? null,
    serviceType:
      slot.serviceType === "lesson" ? "lesson"
      : slot.serviceType === "event" ?
        "event"
      : "simulator",
    raw: slot.raw ?? {},
  }));
}

function deserializeOfferedSlotsFromPayload(payload: Record<string, unknown>): NormalizedWhooshAvailabilitySlot[] | null {
  const rawList = payload.offered_slots;
  if (!Array.isArray(rawList) || rawList.length === 0) return null;

  const out: NormalizedWhooshAvailabilitySlot[] = [];
  for (const row of rawList) {
    if (!row || typeof row !== "object") return null;
    const o = row as Record<string, unknown>;
    const st = typeof o.startTime === "string" ? o.startTime : "";
    const en = typeof o.endTime === "string" ? o.endTime : "";
    const bayRaw =
      typeof o.bayOrResourceId === "string" ?
        o.bayOrResourceId
      : typeof o.resource_id === "string" ?
        o.resource_id
      : "";
    const bay = bayRaw.trim();
    if (!st || !en || !bay) return null;

    let serviceType: WhooshServiceType = "simulator";
    if (o.serviceType === "lesson") serviceType = "lesson";
    else if (o.serviceType === "event") serviceType = "event";

    let rawParsed: Record<string, unknown> = {};
    if (o.raw !== null && typeof o.raw === "object" && !Array.isArray(o.raw)) rawParsed = o.raw as Record<string, unknown>;

    out.push({
      startTime: st,
      endTime: en,
      bayOrResourceId: bay,
      resourceName: typeof o.resourceName === "string" ? o.resourceName : null,
      priceEstimate: typeof o.priceEstimate === "string" ? o.priceEstimate : null,
      serviceType,
      raw: rawParsed,
    });
  }

  return out.length === 0 ? null : out;
}

/** Persisted SMS offer snapshot (`booking_actions` availability_lookup completed row). */
export type CompletedAvailabilityOfferRow = {
  created_at: string | null;
  business_id: string | null;
  conversation_id: string | null;
  contact_id: string | null;
  requested_date: string | null;
  service_type: string | null;
  party_size: number | null;
  duration_minutes: number | null;
  raw_payload: Record<string, unknown>;
};

const STORED_OFFER_MAX_AGE_MS = 10 * 60 * 1000;

function coerceYmdComparable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const s = value.trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  const n = typeof value === "number" ? value : Number.NaN;
  if (Number.isFinite(n) && n > 40000) return DateTime.fromMillis(n).toUTC().toFormat("yyyy-MM-dd");
  return null;
}

async function fetchLatestCompletedAvailabilityOfferRow(
  supabase: SupabaseClient,
  params: {
    businessId: string;
    conversationId: string | null;
    contactId: string | null;
    serviceType: WhooshServiceType;
    requestedDateIso: string | null;
  }
): Promise<CompletedAvailabilityOfferRow | null> {
  let query = supabase
    .from("booking_actions")
    .select(
      "created_at, business_id, conversation_id, contact_id, requested_date, service_type, party_size, duration_minutes, raw_payload"
    )
    .eq("business_id", params.businessId)
    .eq("action_type", "availability_lookup")
    .eq("status", "completed");

  if (params.conversationId) query = query.eq("conversation_id", params.conversationId);
  if (params.contactId) query = query.eq("contact_id", params.contactId);
  query = query.eq(
    "service_type",
    params.serviceType === "lesson" ? "lesson" : params.serviceType === "event" ? "event" : "simulator"
  );
  if (params.requestedDateIso) query = query.eq("requested_date", params.requestedDateIso);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();

  if (error?.message) {
    console.error("[sms-booking-flow] booking_actions SELECT failed:", error.message);
    return null;
  }
  if (!data || typeof data !== "object") return null;

  const d = data as Record<string, unknown>;
  const raw = d.raw_payload;
  const payload =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  return {
    created_at: typeof d.created_at === "string" ? d.created_at : null,
    business_id:
      typeof d.business_id === "string" ?
        d.business_id
      : d.business_id !== null && d.business_id !== undefined ? String(d.business_id) : null,
    conversation_id:
      typeof d.conversation_id === "string" ?
        d.conversation_id
      : d.conversation_id !== null && d.conversation_id !== undefined ? String(d.conversation_id) : null,
    contact_id:
      typeof d.contact_id === "string" ?
        d.contact_id
      : d.contact_id !== null && d.contact_id !== undefined ? String(d.contact_id) : null,
    requested_date:
      typeof d.requested_date === "string" ? d.requested_date
      : d.requested_date instanceof Date ?
        DateTime.fromJSDate(d.requested_date).toFormat("yyyy-MM-dd")
      : coerceYmdComparable(d.requested_date),
    service_type:
      typeof d.service_type === "string" ? d.service_type.trim().toLowerCase() : null,
    party_size:
      typeof d.party_size === "number" && Number.isFinite(d.party_size)
        ? Math.trunc(d.party_size)
        : typeof d.party_size === "string"
          ? Math.trunc(Number(d.party_size.trim())) || null
          : null,
    duration_minutes:
      typeof d.duration_minutes === "number" && Number.isFinite(d.duration_minutes) ?
        Math.trunc(d.duration_minutes)
      : typeof d.duration_minutes === "string" ?
        Math.trunc(Number(d.duration_minutes.trim())) || null
      : null,
    raw_payload: payload,
  };
}

/** True when inbound clearly starts a fresh booking inquiry (suppresses stale enumerated offers). */
export function latestInboundLooksLikeFreshBookingRequest(inbound: string): boolean {
  const t = inbound.toLowerCase().trim();
  if (!t) return false;

  const mentionsCalendarPartyOrBookingScope =
    /\b(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|tomorrow|today|\d{4}-\d{2}-\d{2}|for\s+(?:a\s+)?\d+(?:\.\d+)?\s*(?:hrs?|hours?)|for\s+\d+\s+players?|\d+\s+players?|half\s+hour|half-hour|(?:one|two|three|\d+)\s*(?:hrs?|hours?))\b/i.test(
      inbound
    ) || /\b(?:bay|simulator|sim\b|lesson|event)\b/i.test(t);

  if (
    inboundMentionsLikelyOfferedClock(inbound) &&
    !mentionsCalendarPartyOrBookingScope &&
    /\b(?:book(?:ing)?|i\s*want\s+to\s+book|i'?d\s+like\s+to\s+book)\b/i.test(t)
  ) {
    /* "Book / I want to book 11:15" clock-only confirmations are slot picks, not fresh browse sessions. */
    return false;
  }

  if (
    /\b(i\s+want\s+to\s+book|i'?d\s+like\s+to\s+book|book\s+a\s+bay|book\s+(?:a\s+)?sim(?:ulator)?|book\s+(?:a\s+)?simulator\b|reserve\s+a\s+bay|schedule\s+a\s+bay)\b/i.test(
      inbound
    )
  )
    return true;
  if (
    /\b(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/i.test(
      inbound
    )
  )
    return true;
  if (/\bfor\s+(?:a\s+)?\d+(?:\.\d+)?\s*(?:hrs?|hours?)\b/i.test(t)) return true;
  if (/\bfor\s+\d+\s+players?\b/i.test(t)) return true;
  if (/\b\d+\s+players?\b/i.test(t)) return true;
  if (
    /\b(?:half\s+hour|half-hour|(?:one|two|three|\d+)\s*(?:hrs?|hours?))\b/i.test(t)
  )
    return true;
  return false;
}

export type StoredOfferEvaluateResult =
  | { ok: false; reason: string; diagnostics: StoredOfferDiagnostics }
  | { ok: true; slots: NormalizedWhooshAvailabilitySlot[]; agendaDateIso: string; diagnostics: StoredOfferDiagnostics };

export type StoredOfferDiagnostics = {
  foundStoredOffer: boolean;
  contactMatch: boolean | null;
  conversationMatch: boolean | null;
  requestedDateMatch: boolean | null;
  offerAgeSeconds: number | null;
};

export function evaluateStoredAvailabilityOfferForSms(params: {
  row: CompletedAvailabilityOfferRow | null;
  conversationContactId: string | null;
  conversationId: string | null;
  businessId: string;
  nowMs: number;
  currentFactsIsoDate: string | null;
  currentServiceType: WhooshServiceType;
  browseDurationMinutes: number;
  /** Omit party parity when null — follow-up replies often omit player count pulled from stored context. */
  currentPartyFromFactsOrNull: number | null;
  /** Only compare party when transcript explicitly resolves a party size. */
  partyExplicitInLatestTranscript: boolean;
  /** Only compare browse duration once simulator/Lesson minutes are explicit from transcript vs defaults. */
  durationExplicitInLatestTranscript: boolean;
  supersedeOffersForFreshBookingPhrase: boolean;
}): StoredOfferEvaluateResult {
  const {
    row,
    conversationContactId,
    businessId,
    nowMs,
    currentFactsIsoDate,
    currentServiceType,
    browseDurationMinutes,
    currentPartyFromFactsOrNull,
    partyExplicitInLatestTranscript,
    durationExplicitInLatestTranscript,
    supersedeOffersForFreshBookingPhrase,
  } = params;

  const rowDate = coerceYmdComparable(row?.requested_date);
  const createdMs = row?.created_at ? Date.parse(row.created_at) : Number.NaN;
  const diagnostics: StoredOfferDiagnostics = {
    foundStoredOffer: !!row,
    contactMatch:
      row ? ((conversationContactId ?? "") === (row.contact_id ?? "")) : null,
    conversationMatch:
      row ? ((params.conversationId ?? "") === (row.conversation_id ?? "")) : null,
    requestedDateMatch:
      row && currentFactsIsoDate && rowDate ? rowDate === currentFactsIsoDate.slice(0, 10) : row ? null : null,
    offerAgeSeconds:
      Number.isFinite(createdMs) ? Math.max(0, Math.round((nowMs - createdMs) / 1000)) : null,
  };

  if (!row || !row.raw_payload) return { ok: false, reason: "no_stored_offer_row", diagnostics };

  if (supersedeOffersForFreshBookingPhrase) return { ok: false, reason: "superseded_by_new_booking_request", diagnostics };

  const cid = conversationContactId ?? null;
  const rid = row.contact_id ?? null;
  if ((cid ?? "") !== (rid ?? ""))
    return { ok: false, reason: "stored_offer_contact_mismatch", diagnostics };

  if (((params.conversationId ?? "") !== (row.conversation_id ?? "")))
    return { ok: false, reason: "stored_offer_conversation_mismatch", diagnostics };

  if (row.business_id && row.business_id !== businessId)
    return { ok: false, reason: "stored_offer_business_mismatch", diagnostics };

  if (!Number.isFinite(createdMs) || nowMs - createdMs > STORED_OFFER_MAX_AGE_MS)
    return { ok: false, reason: "stored_offer_expired (>10min)", diagnostics };

  if (currentFactsIsoDate && rowDate && rowDate !== currentFactsIsoDate.slice(0, 10))
    return { ok: false, reason: "stored_offer_requested_date_mismatch", diagnostics };

  const rowSvc = row.service_type;
  const curSvc = currentServiceType === "lesson" ? "lesson" : currentServiceType === "event" ? "event" : "simulator";
  if (rowSvc && curSvc !== rowSvc) return { ok: false, reason: "stored_offer_service_type_mismatch", diagnostics };

  const rParty = row.party_size;
  if (
    partyExplicitInLatestTranscript &&
    currentPartyFromFactsOrNull !== null &&
    typeof rParty === "number" &&
    Number.isFinite(rParty) &&
    rParty >= 1 &&
    rParty !== currentPartyFromFactsOrNull
  )
    return { ok: false, reason: "stored_offer_party_size_mismatch", diagnostics };

  const rDur = row.duration_minutes;
  if (
    durationExplicitInLatestTranscript &&
    typeof rDur === "number" &&
    Number.isFinite(rDur) &&
    rDur >= 30 &&
    rDur !== browseDurationMinutes
  )
    return { ok: false, reason: "stored_offer_duration_minutes_mismatch", diagnostics };

  const slots = deserializeOfferedSlotsFromPayload(row.raw_payload);
  if (!slots?.length)
    return { ok: false, reason: "stored_offer_payload_missing_offered_slots", diagnostics };

  let agendaIso =
    coerceYmdComparable(row.raw_payload.agenda_date) ??
    coerceYmdComparable(slots[0]?.raw?.agenda_date as string | undefined);
  agendaIso ??= rowDate ?? currentFactsIsoDate?.slice(0, 10) ?? null;

  if (!agendaIso) agendaIso = "1970-01-01";

  return {
    ok: true,
    slots,
    agendaDateIso: agendaIso,
    diagnostics,
  };
}

function normalizeSmsClockHay(s: string): string {
  return s.toLowerCase().replace(/\u202f/g, " ").replace(/\s+/g, " ").trim();
}

function smsClockHayNormalizedFromInbound(subject: string): string {
  return subject.toLowerCase().replace(/\s+/g, "");
}

/** Match outbound copy like Sun May 17: ... 11:30 AM … */
export function inboundMentionsLikelyOfferedClock(subject: string): boolean {
  if (/\d{1,2}\s*[.:]\s*\d{2}\s*(?:am|pm)?\b/i.test(subject)) return true;
  if (/\b\d{1,2}\s*(?:am|pm)\b/i.test(subject)) return true;
  return false;
}

function matchOrdinalOfferIndex(inbound: string, offerCount: number): number | null {
  const lower = inbound.toLowerCase();
  if (/\b(?:first)\b(?:\s*(?:one|slot|option|choice|pick|opening|bay))?\b|\b1\s*st\b/.test(lower))
    return offerCount >= 1 ? 0 : null;
  if (/\b(?:second)\b(?:\s*(?:one|slot|option|choice|pick|opening|bay))?\b|\b2\s*nd\b/.test(lower))
    return offerCount >= 2 ? 1 : null;
  if (
    /\b(?:third|3\s*rd)\b(?:\s*(?:one|slot|option|choice|pick|opening|bay))?\b|\b(?:the\s+)?third\b/.test(
      lower
    )
  )
    return offerCount >= 3 ? 2 : null;
  if (/\blast\s+(one|slot|option|choice|pick|opening|bay)\b/.test(lower))
    return offerCount >= 1 ? offerCount - 1 : null;
  const oneTwoThree =
    /\b(one|two|three)\s+(?:slot|opening|pick|choice|bay|works|is\s+good|please)\b/i.exec(lower);
  if (oneTwoThree?.[1]) {
    const map: Record<string, number> = { one: 0, two: 1, three: 2 };
    const ix = map[oneTwoThree[1].toLowerCase()];
    return typeof ix === "number" && ix < offerCount ? ix : null;
  }
  return null;
}

function matchLoneSlotDigitChoice(trimmed: string, offerCount: number): number | null {
  const max = Math.min(offerCount, 3);
  if (/^[1-3]\s*[.!?,]*$/i.test(trimmed)) {
    const d = Number(trimmed[0]);
    return d <= max ? d - 1 : null;
  }
  return null;
}

function matchOptionPhraseSlotIndex(trimmed: string, offerCount: number): number | null {
  const max = Math.min(offerCount, 3);
  const rm = trimmed.match(/^option\s*([1-3])\b|^#\s*([1-3])\b/i);
  if (rm?.[1] || rm?.[2]) {
    const digit = Number(rm[1] ?? rm[2]);
    if (digit >= 1 && digit <= max) return digit - 1;
  }

  const anyOpt = /\b(?:option|number|#\s*|pick\s*)\s*([1-3])\b/i.exec(trimmed);
  if (anyOpt?.[1]) {
    const digit = Number(anyOpt[1]);
    return digit >= 1 && digit <= max ? digit - 1 : null;
  }
  return null;
}

function clockPickOfferIndex(inbound: string, offeredSlots: NormalizedWhooshAvailabilitySlot[]): number | null {
  if (!inboundMentionsLikelyOfferedClock(inbound)) return null;

  const hay = smsClockHayNormalizedFromInbound(inbound);

  const substringHits = new Set<number>();

  for (let i = 0; i < offeredSlots.length; i += 1) {
    const la = DateTime.fromISO(offeredSlots[i].startTime, { zone: "utc" }).setZone("America/Los_Angeles");
    if (!la.isValid) continue;

    const hour12 = la.hour % 12 === 0 ? 12 : la.hour % 12;
    const mm = String(la.minute).padStart(2, "0");
    const suffix = la.hour >= 12 ? "pm" : "am";

    const needles = [
      smsClockHayNormalizedFromInbound(`${hour12}:${mm}${suffix}`),
      smsClockHayNormalizedFromInbound(`${hour12}:${mm} ${suffix}`),
      smsClockHayNormalizedFromInbound(la.toFormat("h:mm a")),
    ];

    for (const c of needles) {
      if (c.length >= 6 && hay.includes(c)) substringHits.add(i);
    }

    const compactHm = smsClockHayNormalizedFromInbound(`${hour12}${mm}`);
    if (compactHm.length >= 4 && hay.includes(compactHm)) substringHits.add(i);
  }

  if (substringHits.size === 1) return [...substringHits][0]!;

  const blobs =
    inbound.match(/\b\d{1,2}\s*[.:]\s*\d{2}(?:\s*(?:am|pm))?\b|\b\d{1,2}\s*(?:am|pm)\b/gi) ?? [];

  const minuteHitsIdx = new Set<number>();

  for (const blob of blobs) {
    for (let i = 0; i < offeredSlots.length; i += 1) {
      const slotLa = DateTime.fromISO(offeredSlots[i].startTime, { zone: "utc" }).setZone(
        "America/Los_Angeles"
      );
      if (!slotLa.isValid) continue;
      const slotM = slotLa.hour * 60 + slotLa.minute;

      const candidates = parseLosAngelesFlexibleClockCandidates(blob.trim(), slotLa);
      for (const c of candidates) {
        const m = c.hour * 60 + c.minute;
        if (Math.abs(m - slotM) <= 14) minuteHitsIdx.add(i);
      }
    }
  }

  return minuteHitsIdx.size === 1 ? [...minuteHitsIdx][0]! : null;
}

function parseLosAngelesFlexibleClockCandidates(
  fragment: string,
  anchorLa: DateTime
): Array<{ hour: number; minute: number }> {
  const trimmed = fragment.trim();

  const out: Array<{ hour: number; minute: number }> = [];

  const colonAmPm = /\b(\d{1,2})\s*[.:]\s*(\d{2})\s*(am|pm)\b/i.exec(trimmed);
  if (colonAmPm?.[1] && colonAmPm[2] && colonAmPm[3]) {
    let h = Number(colonAmPm[1]);
    const mins = Number(colonAmPm[2]);
    if (!Number.isFinite(h) || !Number.isFinite(mins)) return out;
    const mer = colonAmPm[3].toLowerCase() === "pm" ? "pm" : "am";
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    out.push({ hour: h, minute: mins });
    return out;
  }

  const colonNoMer = /\b(\d{1,2})\s*[.:]\s*(\d{2})\b/.exec(trimmed);
  if (colonNoMer?.[1] && colonNoMer[2]) {
    const displayH = Number(colonNoMer[1]);
    const mins = Number(colonNoMer[2]);
    if (!Number.isFinite(displayH) || !Number.isFinite(mins)) return out;

    const asAm = (): { hour: number; minute: number } => ({
      hour: displayH === 12 ? 0 : displayH,
      minute: mins,
    });
    const asPm = (): { hour: number; minute: number } => ({
      hour: displayH === 12 ? 12 : displayH + 12,
      minute: mins,
    });

    if (anchorLa.hour >= 12) {
      out.push(asPm());
      if (anchorLa.hour <= 13) out.push(asAm());
    } else {
      out.push(asAm());
      out.push(asPm());
    }
    return out;
  }

  const bareWithMer = /\b(\d{1,2})\s*(am|pm)\b/i.exec(trimmed);
  if (bareWithMer?.[1] && bareWithMer[2]) {
    let h = Number(bareWithMer[1]);
    const mins = 0;
    const mer = bareWithMer[2].toLowerCase() === "pm" ? "pm" : "am";
    if (!Number.isFinite(h)) return out;
    if (mer === "pm" && h < 12) h += 12;
    if (mer === "am" && h === 12) h = 0;
    out.push({ hour: h, minute: mins });
  }

  return out;
}

/**
 * Infer which enumerated Whoosh preview slot (0-based) matches the inbound reply.
 */
export function resolveOfferedSlotPickIndex(
  inbound: string,
  offeredSlots: NormalizedWhooshAvailabilitySlot[]
): number | null {
  const trimmed = inbound.trim();
  const n = offeredSlots.length;
  if (n === 0) return null;

  const ordIx = matchOrdinalOfferIndex(trimmed, n);
  if (typeof ordIx === "number") return ordIx;

  const optIx = matchOptionPhraseSlotIndex(trimmed, n);
  if (typeof optIx === "number") return optIx;

  const clockIx = clockPickOfferIndex(inbound, offeredSlots);
  if (typeof clockIx === "number") return clockIx;

  const loneIx = matchLoneSlotDigitChoice(trimmed, n);
  if (typeof loneIx === "number") return loneIx;

  return null;
}

export function inboundIndicatesSlotOfferResponse(inbound: string, offerCount: number): boolean {
  const trimmed = inbound.trim();
  if (!trimmed) return false;
  if (/^(yes|yeah|yep|yup|sure|ok|okay|perfect|looks\s+good|that'?s\s+right|correct|sounds\s+good)$/i.test(trimmed))
    return false;

  const n = Math.min(Math.max(offerCount, 1), 3);

  if (matchOrdinalOfferIndex(trimmed, n) !== null) return true;
  if (matchOptionPhraseSlotIndex(trimmed, n) !== null) return true;
  if (matchLoneSlotDigitChoice(trimmed, n) !== null) return true;
  if (inboundMentionsLikelyOfferedClock(trimmed)) return true;

  if (/\b(?:book|booking|grab|want|I'll take)\b.+?\b(?:one|two|three|third|second|first)\b/i.test(trimmed.toLowerCase()))
    return true;

  if (/\b(?:book|booking|grab|want|I'll take)\b.+?[1-3]\b/.test(trimmed.toLowerCase())) return true;

  return false;
}

function formatDurationLabel(minutes: number | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return null;
  const rounded = Math.round(minutes);
  if (rounded % 60 === 0) {
    const h = rounded / 60;
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  return `${rounded} minutes`;
}

export function formatSmsSlotOffers(
  offeredSlots: NormalizedWhooshAvailabilitySlot[],
  dateIso: string,
  durationMinutes?: number | null
) {
  const dateLabel = DateTime.fromISO(dateIso, {
    zone: "America/Los_Angeles",
  }).toFormat("ccc LLL d");
  const labels = offeredSlots.map((slot) => {
    const readableStart = DateTime.fromISO(slot.startTime, { zone: "utc" }).setZone(
      "America/Los_Angeles"
    );
    const effectiveEndIso =
      typeof durationMinutes === "number" && Number.isFinite(durationMinutes) ?
        slotEndIsoForDurationMinutes(slot.startTime, durationMinutes)
      : slot.endTime;
    const readableEnd = DateTime.fromISO(effectiveEndIso, { zone: "utc" }).setZone(
      "America/Los_Angeles"
    );
    if (!readableStart.isValid) return slot.startTime;
    if (readableEnd.isValid) return `${readableStart.toFormat("h:mm a")}-${readableEnd.toFormat("h:mm a")}`;
    return readableStart.toFormat("h:mm a");
  });
  let listSentence: string;
  if (labels.length === 1) listSentence = labels[0] ?? "";
  else if (labels.length === 2) listSentence = `${labels[0]} and ${labels[1]}`;
  else listSentence = `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  const durationLabel = formatDurationLabel(durationMinutes);
  const durationPhrase = durationLabel ? ` for ${durationLabel}` : "";
  const body = `${dateLabel}: I see ${listSentence} available${durationPhrase}. Reply 1, 2, or 3.`;
  return body.slice(0, 318);
}

/** Slot pick narrow enough for reusing enumerated offers — not full booking prose. */
export function inboundIsStrictSlotSelectionForOffers(
  inbound: string,
  offeredSlots: NormalizedWhooshAvailabilitySlot[]
): boolean {
  const trimmed = inbound.trim();
  if (!trimmed) return false;
  const nOffer = Math.min(Math.max(offeredSlots.length, 1), 3);
  const lower = trimmed.toLowerCase();

  if (
    /^(yes|yeah|yep|yup|sure|ok|okay|perfect|looks\s+good|that'?s\s+right|correct|sounds\s+good)$/i.test(
      trimmed
    )
  )
    return false;

  if (
    /\b(book|booking|grab|want|i'?ll\s+take)\b.+?\b(?:first|second|third|three|two|one)\b/i.test(lower)
  )
    return true;
  if (/\bbook(?:ing)?\s+\d{1,2}\s*[.:]\s*\d{2}\b/i.test(trimmed)) return true;

  if (matchOrdinalOfferIndex(trimmed, nOffer) !== null) return true;
  if (matchOptionPhraseSlotIndex(trimmed, nOffer) !== null) return true;
  if (matchLoneSlotDigitChoice(trimmed, nOffer) !== null) return true;

  if (
    /\b\d{1,2}\s*[.:]\s*\d{2}\s*(?:am|pm)\s+(?:is\s+)?(?:good|great|works|perfect)\b/i.test(lower)
  )
    return true;
  if (/\b\d{1,2}\s*[.:]\s*\d{2}\s+(?:is\s+)?(?:good|great|works|perfect)\b/i.test(lower))
    return true;

  if (inboundMentionsLikelyOfferedClock(trimmed)) {
    const clockIx = clockPickOfferIndex(inbound, offeredSlots);
    return typeof clockIx === "number";
  }

  return false;
}

function lastOutboundContainsSlotFingerprints(
  history: ConversationHistoryMessage[],
  offeredSlots: NormalizedWhooshAvailabilitySlot[]
): boolean {
  if (offeredSlots.length === 0) return false;
  const outbound = [...history].reverse().find((m) => m.direction === "outbound");
  const textRaw = outbound?.message_text;
  const text =
    typeof textRaw === "string" ? textRaw.toLowerCase().replace(/\u202f/g, " ") : "";
  if (!text) return false;

  for (const slot of offeredSlots.slice(0, 3)) {
    const la = DateTime.fromISO(slot.startTime, { zone: "utc" }).setZone("America/Los_Angeles");
    if (!la.isValid) return false;

    const hh12 = ((h: number) => (h % 12 === 0 ? 12 : h % 12))(la.hour);
    const mm = la.minute;
    const suf = la.hour >= 12 ? "pm" : "am";
    const patterns = [
      la.toFormat("h:mm a").toLowerCase(),
      `${hh12}:${String(mm).padStart(2, "0")} ${suf}`,
      `${hh12}:${String(mm).padStart(2, "0")}${suf}`,
    ];
    const hit = patterns.some((p) => text.includes(p));
    if (!hit) return false;
  }
  return true;
}

function chooseEnumeratedOfferClarificationReply(params: {
  offeredSlots: NormalizedWhooshAvailabilitySlot[];
  agendaDateIso: string;
  conversationHistory: ConversationHistoryMessage[];
  durationMinutes?: number | null;
}): string {
  const { offeredSlots, agendaDateIso, conversationHistory, durationMinutes } = params;
  if (lastOutboundContainsSlotFingerprints(conversationHistory, offeredSlots)) {
    return "Reply 1, 2, or 3 for one of those times I listed above—or say the clock time verbatim (example: 11:30 AM).";
  }
  const body = formatSmsSlotOffers(offeredSlots, agendaDateIso, durationMinutes);
  return `${body.slice(0, 280)} Or say the clock time verbatim (example: 11:30 AM).`.slice(0, 318);
}

/** Numeric / option pick only (does not inspect clock wording). Exported for tooling/tests. */

export function matchOfferedSlotOptionIndex(inbound: string, offerCount: number): number | null {
  const trimmed = inbound.trim();
  return (
    matchOrdinalOfferIndex(trimmed, offerCount) ??
    matchOptionPhraseSlotIndex(trimmed, offerCount) ??
    matchLoneSlotDigitChoice(trimmed, offerCount)
  );
}

/** Affirmative short replies without choosing a numbered Whoosh opening. */
export function customerAffirmsWithoutSlotDigitChoice(inbound: string): boolean {
  const trimmed = inbound.trim();
  if (!trimmed) return false;
  if (/^([1-3])\b|^option\s*[1-3]/i.test(trimmed)) return false;
  if (/^\d{1,2}\s*[.:]\s*\d{2}\b/i.test(trimmed)) return false;
  if (/\b\d{1,2}\s*(?:am|pm)\b/i.test(trimmed)) return false;

  const t = trimmed.toLowerCase();
  return /^(yes|yeah|yep|yup|sure|ok|okay|perfect|looks\s+good|that'?s\s+right|correct|sounds\s+good)\b/.test(t);
}

export function isSyntheticWhooshResourceId(bayOrResourceId: string | null | undefined): boolean {
  const s = (bayOrResourceId ?? "").trim();
  return !s || s.startsWith("composer:");
}

export function inferredSlotDurationMinutes(slot: NormalizedWhooshAvailabilitySlot): number | null {
  const s = DateTime.fromISO(slot.startTime, { zone: "utc" });
  const e = DateTime.fromISO(slot.endTime, { zone: "utc" });
  if (!s.isValid || !e.isValid) return null;
  const mins = Math.round(e.diff(s, "minutes").minutes);
  return Number.isFinite(mins) && mins > 0 ? mins : null;
}

function slotEndIsoForDurationMinutes(slotStartIso: string, durationMinutes: number): string {
  const start = DateTime.fromISO(slotStartIso, { zone: "utc" });
  if (!start.isValid) return slotStartIso;
  return start.plus({ minutes: Math.max(1, Math.round(durationMinutes)) }).toUTC().toISO() ?? slotStartIso;
}

export async function runCloseOsSmsBookingAugmentation(params: {
  supabase: SupabaseClient;
  businessId: string;
  conversationId: string;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  inboundText: string;
  playbook: string;
  conversationHistory: ConversationHistoryMessage[];
  /**
   * Bay duration fallback when transcript omits it. Omit/unset env → Primetime 60 unless
   * `SMS_SIMULATOR_BAY_DEFAULT_DURATION_MINUTES` disables it (`0`|`none`|`off`|`false`|`explicit`).
   * Pass `null` to force explicit duration (no default).
   */
  simulatorBayDefaultDurationMinutes?: number | null;
  /** Whoosh / club member id when present on the contact row. */
  contactMemberNumber?: string | null;
}): Promise<BookingFlowAugmentation> {
  const anchorLA = DateTime.now().setZone(BUSINESS_TIMEZONE);
  const transcript = mergeTranscript(params.conversationHistory, params.inboundText);
  const lower = transcript.toLowerCase();
  const bookingCueHit = containsBookingCue(lower);

  let effectivePlaybook = params.playbook;
  if (effectivePlaybook === "general" && bookingCueHit) {
    if (/\b(lesson|lessons|coach|instruction)\b/i.test(lower)) effectivePlaybook = "lesson";
    else if (/\b(event|party|corporate|birthday|outing)\b/i.test(lower)) effectivePlaybook = "event";
    else effectivePlaybook = "simulator";
  }

  const { facts, dateResolution } = collectBookingFactsWithDateResolution(
    effectivePlaybook,
    transcript,
    params.inboundText,
    anchorLA
  );
  const dateDebug = {
    inbound_text: params.inboundText,
    resolved_requested_date: dateResolution.isoDate,
    date_source: dateResolution.source,
    timezone: BUSINESS_TIMEZONE,
  } as const;

  const bayDefaultResolved =
    params.simulatorBayDefaultDurationMinutes !== undefined ?
      params.simulatorBayDefaultDurationMinutes
    : readSimulatorBayDefaultDurationMinutesFromEnv();

  const simulatorDurResolve =
    facts.serviceType === "simulator" ?
      resolveSimulatorBayDurationMinutes(facts, bayDefaultResolved)
    : ({ minutes: null, defaulted: false } as const);

  const durationDefaultedDebug =
    bookingCueHit && facts.serviceType === "simulator" && simulatorDurResolve.defaulted;

  /** Pricing FAQs */
  const pricingOnlyStandalone =
    !bookingCueHit &&
    (isLikelyStandalonePricingQuestion(params.inboundText) ||
      isLikelyLessonPricingQuestion(params.inboundText));

  if (pricingOnlyStandalone && /\blesson\b/i.test(params.inboundText)) {
    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      replyText: `${lessonPricingSentence()} (${PRIMETIME_LOCATION_LINE}; ${PRIMETIME_WEBSITE}).`,
      bookingConfirmedByWhoosh: false,
      debug: {
        intent: "pricing",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: false,
        requiredDetailsMissing: [],
        selectedSlotSource: "none",
        reason: "standalone_lesson_pricing",
        ...dateDebug,
      },
    };
  }

  if (pricingOnlyStandalone && /\b(bay|simulator|sim|practice)\b/i.test(lower)) {
    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      replyText: compactPricingSmsForBayQuestion(),
      bookingConfirmedByWhoosh: false,
      debug: {
        intent: "pricing",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: false,
        requiredDetailsMissing: [],
        selectedSlotSource: "none",
        reason: "standalone_bay_sim_pricing",
        ...dateDebug,
      },
    };
  }

  const trimmedInbound = params.inboundText.trim();

  const browseDurationMinutesForStoredOfferEval =
    facts.serviceType === "lesson" ?
      facts.lessonDurationMinutes ?? 60
    : simulatorDurResolve.minutes ?? facts.simulatorDurationMinutes ?? 60;

  const latestInboundIsNewBookingRequest = latestInboundLooksLikeFreshBookingRequest(trimmedInbound);

  const completedOfferRow = await fetchLatestCompletedAvailabilityOfferRow(
    params.supabase,
    {
      businessId: params.businessId,
      conversationId: params.conversationId,
      contactId: params.contactId,
      serviceType: facts.serviceType,
      requestedDateIso: facts.isoDate,
    }
  );

  const storedAvailabilityEval = evaluateStoredAvailabilityOfferForSms({
    row: completedOfferRow,
    conversationContactId: params.contactId,
    conversationId: params.conversationId,
    businessId: params.businessId,
    nowMs: Date.now(),
    currentFactsIsoDate: facts.isoDate,
    currentServiceType: facts.serviceType,
    browseDurationMinutes: browseDurationMinutesForStoredOfferEval,
    currentPartyFromFactsOrNull: facts.partySize,
    partyExplicitInLatestTranscript: facts.partySize !== null,
    durationExplicitInLatestTranscript:
      facts.serviceType === "lesson" ?
        facts.lessonDurationMinutes !== null
      : facts.simulatorDurationMinutes !== null,
    supersedeOffersForFreshBookingPhrase: latestInboundIsNewBookingRequest,
  });

  const offersAwaitingStored = storedAvailabilityEval.ok ? storedAvailabilityEval.slots : null;
  const offerCount = offersAwaitingStored?.length ?? 0;
  const latestInboundHasNumericOfferPick = matchOfferedSlotOptionIndex(trimmedInbound, 3) !== null;

  const latestInboundIsSlotPick =
    storedAvailabilityEval.ok ?
      inboundIsStrictSlotSelectionForOffers(trimmedInbound, storedAvailabilityEval.slots)
    : latestInboundHasNumericOfferPick;

  const storedOfferRejectedReason =
    storedAvailabilityEval.ok ? null
    : latestInboundIsNewBookingRequest ? "superseded_by_new_booking_request"
    : storedAvailabilityEval.reason;
  const storedOfferDiagnostics = storedAvailabilityEval.diagnostics;

  const smsOfferDebug = {
    latestInboundIsNewBookingRequest,
    latestInboundIsSlotPick,
    usingStoredOfferSlots: storedAvailabilityEval.ok,
    foundStoredOffer: storedOfferDiagnostics.foundStoredOffer,
    storedOfferRejectedReason,
    contactMatch: storedOfferDiagnostics.contactMatch,
    conversationMatch: storedOfferDiagnostics.conversationMatch,
    requestedDateMatch: storedOfferDiagnostics.requestedDateMatch,
    offerAgeSeconds: storedOfferDiagnostics.offerAgeSeconds,
    ...dateDebug,
  } as const;

  const smsOfferDebugNoFreshLookup = { ...smsOfferDebug, freshLookupReason: null as string | null };

  const freshLookupExplanation = storedAvailabilityEval.ok ? null : storedAvailabilityEval.reason;

  const smsOfferDebugForLookupTrail = {
    ...smsOfferDebug,
    freshLookupReason: freshLookupExplanation,
  };

  if (!storedAvailabilityEval.ok && latestInboundHasNumericOfferPick) {
    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      bookingConfirmedByWhoosh: false,
      replyText:
        "I don't want to guess on an old set of times. What day and time should I check for you?",
      debug: {
        intent: "missing_details",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: false,
        requiredDetailsMissing: ["date", "time_range"],
        selectedSlotSource: "none",
        reason: "numeric_slot_pick_without_valid_stored_offer",
        ...smsOfferDebugNoFreshLookup,
      },
    };
  }

  /** Customer reacting to enumerated Whoosh openings: numbered picks, ordinal phrases, clock times. */
  if (
    storedAvailabilityEval.ok &&
    offerCount > 0 &&
    customerAffirmsWithoutSlotDigitChoice(trimmedInbound) &&
    !latestInboundIsSlotPick
  ) {
    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      bookingConfirmedByWhoosh: false,
      replyText: chooseEnumeratedOfferClarificationReply({
        offeredSlots: offersAwaitingStored!,
        agendaDateIso: storedAvailabilityEval.agendaDateIso,
        conversationHistory: params.conversationHistory,
        durationMinutes: browseDurationMinutesForStoredOfferEval,
      }),
      debug: {
        intent: "missing_details",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: durationDefaultedDebug,
        requiredDetailsMissing: ["numeric_slot_choice"],
        selectedSlotSource: "none",
        reason: "affirmed_without_whoosh_option_digit",
        ...smsOfferDebugNoFreshLookup,
      },
    };
  }

  if (storedAvailabilityEval.ok && offerCount > 0 && latestInboundIsSlotPick) {
    const awaitingSlots = offersAwaitingStored!;
    const pickIdx = resolveOfferedSlotPickIndex(trimmedInbound, awaitingSlots);
    const pick = typeof pickIdx === "number" ? awaitingSlots[pickIdx] : undefined;

    if (pick) {
      if (isSyntheticWhooshResourceId(pick.bayOrResourceId)) {
        await emitSmsBookingAudit(
          params.supabase,
          params.conversationId,
          params.businessId,
          "sms_booking_create_failed",
          { stage: "resource", reason: "synthetic_or_missing_slot_id" }
        );
        return {
          kind: "direct_outbound",
          bypassRiskyResponseGuard: false,
          bookingConfirmedByWhoosh: false,
          replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
          debug: {
            intent: "booking_create",
            whooshAvailabilityAttempted: true,
            whooshBookingAttempted: false,
            whooshBookingConfirmed: false,
            durationDefaulted: durationDefaultedDebug,
            requiredDetailsMissing: ["whoosh_slot_resource"],
            selectedSlotSource: "whoosh",
            reason: "synthetic_whoosh_resource_id",
            ...smsOfferDebugNoFreshLookup,
          },
        };
      }

      const slotDur = inferredSlotDurationMinutes(pick);
      if (slotDur === null) {
        await emitSmsBookingAudit(
          params.supabase,
          params.conversationId,
          params.businessId,
          "sms_booking_create_failed",
          { stage: "slot_duration" }
        );
        return {
          kind: "direct_outbound",
          bypassRiskyResponseGuard: false,
          bookingConfirmedByWhoosh: false,
          replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
          debug: {
            intent: "booking_create",
            whooshAvailabilityAttempted: true,
            whooshBookingAttempted: false,
            whooshBookingConfirmed: false,
            durationDefaulted: durationDefaultedDebug,
            requiredDetailsMissing: ["slot_duration"],
            selectedSlotSource: "whoosh",
            reason: "missing_slot_start_end",
            ...smsOfferDebugNoFreshLookup,
          },
        };
      }

      const createBlockers: string[] = [];
      if (!isLikelyE164Phone(params.contactPhone)) createBlockers.push("customer_phone");

      const partyFinal =
        pick.serviceType === "lesson" ? (facts.partySize ?? 1) : facts.partySize;
      if (partyFinal === null || partyFinal < 1) createBlockers.push("player_count");

      if (createBlockers.length > 0) {
        const priority = [...new Set(createBlockers)];
        await emitSmsBookingAudit(params.supabase, params.conversationId, params.businessId, "sms_booking_create_failed", {
          stage: "prerequisite",
          priority,
          inbound: trimmedInbound.slice(0, 240),
          selected_slot_preview: pick.startTime,
        });
        const ask = summarizeMissingQuestions(priority as string[], facts, transcript)[0]!;
        return {
          kind: "direct_outbound",
          bypassRiskyResponseGuard: false,
          bookingConfirmedByWhoosh: false,
          replyText: `${ask}`,
          debug: {
            intent: "missing_details",
            whooshAvailabilityAttempted: true,
            whooshBookingAttempted: false,
            whooshBookingConfirmed: false,
            durationDefaulted: durationDefaultedDebug,
            requiredDetailsMissing: priority,
            selectedSlotSource: "whoosh",
            reason: "booking_blocked_missing_whoosh_booking_inputs",
            ...smsOfferDebugNoFreshLookup,
          },
        };
      }

      const partySized = partyFinal as number;

      const durationStored =
        pick.serviceType === "lesson" ?
          facts.lessonDurationMinutes ?? slotDur
        : (facts.simulatorDurationMinutes ?? slotDur);
      const selectedEndTime = slotEndIsoForDurationMinutes(pick.startTime, durationStored);
      const selectedSlotForBooking: NormalizedWhooshAvailabilitySlot = {
        ...pick,
        endTime: selectedEndTime,
      };

      const bookingCreateEnv = getWhooshBookingCreateEnvDiagnostics();
      const selectedSlotResourceId =
        typeof pick.bayOrResourceId === "string" ?
          pick.bayOrResourceId.trim()
        : "";
      const configFailureMetadata = {
        stage: "config" as const,
        inbound: trimmedInbound.slice(0, 240),
        bookingApiEnabled: bookingCreateEnv.bookingApiEnabled,
        bookingPostPathPresent: bookingCreateEnv.bookingPostPathPresent,
        whooshApiBaseUrlPresent: bookingCreateEnv.whooshApiBaseUrlPresent,
        whooshApiTokenPresent: bookingCreateEnv.whooshApiTokenPresent,
        selectedSlotFound: true,
        selectedSlotStartTime: pick.startTime ?? null,
        selectedSlotResourceId: selectedSlotResourceId || null,
        conversationId: params.conversationId ?? null,
        contactId: params.contactId ?? null,
      };

      if (!bookingCreateEnv.bookingApiEnabled || !bookingCreateEnv.bookingPostPathPresent) {
        logWhooshSmsBookingCreateConfigConsole({
          env: bookingCreateEnv,
          bayOrResourceId: selectedSlotResourceId,
        });
        await emitSmsBookingAudit(
          params.supabase,
          params.conversationId,
          params.businessId,
          "sms_booking_create_failed",
          configFailureMetadata
        );
        return {
          kind: "direct_outbound",
          bypassRiskyResponseGuard: false,
          bookingConfirmedByWhoosh: false,
          replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
          extraMetadata: {
            whoosh_booking_api_disabled: true,
            ...configFailureMetadata,
          },
          debug: {
            intent: "booking_create",
            whooshAvailabilityAttempted: true,
            whooshBookingAttempted: false,
            whooshBookingConfirmed: false,
            durationDefaulted: durationDefaultedDebug,
            requiredDetailsMissing: [],
            selectedSlotSource: "whoosh",
            reason: "whoosh_booking_api_not_configured",
            ...smsOfferDebugNoFreshLookup,
          },
        };
      }

      const bookingCreateParams: WhooshBookingCreateParams = {
        contactId: params.contactId ?? "unknown-contact",
        customerName: params.contactName,
        customerPhone: params.contactPhone,
        contactMemberNumber: params.contactMemberNumber ?? null,
        selectedSlot: selectedSlotForBooking,
        partySize: partySized,
        durationMinutes: durationStored,
        availabilityAgendaDate: storedAvailabilityEval.agendaDateIso,
      };

      const memberResolved = resolveWhooshBookingMemberNumber(bookingCreateParams);
      if (!memberResolved.ok) {
        await emitSmsBookingAudit(
          params.supabase,
          params.conversationId,
          params.businessId,
          "sms_booking_create_failed",
          {
            stage: "member_config",
            error: memberResolved.error,
            inbound: trimmedInbound.slice(0, 240),
          }
        );
        return {
          kind: "direct_outbound",
          bypassRiskyResponseGuard: false,
          bookingConfirmedByWhoosh: false,
          replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
          extraMetadata: { whoosh_booking_member_config: true, error: memberResolved.error },
          debug: {
            intent: "booking_create",
            whooshAvailabilityAttempted: true,
            whooshBookingAttempted: false,
            whooshBookingConfirmed: false,
            durationDefaulted: durationDefaultedDebug,
            requiredDetailsMissing: [],
            selectedSlotSource: "whoosh",
            reason: "whoosh_booking_guest_member_unconfigured",
            ...smsOfferDebugNoFreshLookup,
          },
        };
      }

      const simulatorSquareHoldEligible =
        pick.serviceType === "simulator" &&
        bookingCreateEnv.bookingApiEnabled &&
        bookingCreateEnv.bookingPostPathPresent &&
        isCloseOsNonMemberSimulatorPaymentHoldEnabled() &&
        !memberResolved.memberNumberPresent;

      if (simulatorSquareHoldEligible) {
        const holdMinutes = closeOsSimulatorHoldExpirationMinutes();
        const agendaDateForRecheckRaw =
          typeof pick.raw?.agenda_date === "string" ?
            pick.raw.agenda_date.trim()
          : storedAvailabilityEval.agendaDateIso ?? null;

        const agendaDateForRecheck =
          agendaDateForRecheckRaw && /^\d{4}-\d{2}-\d{2}$/.test(agendaDateForRecheckRaw) ?
            agendaDateForRecheckRaw.trim()
          : null;

        if (!agendaDateForRecheck) {
          await emitSmsBookingAudit(
            params.supabase,
            params.conversationId,
            params.businessId,
            "sms_booking_hold_failed",
            { reason: "missing_agenda_date_for_square_hold_recheck", slot: pick.startTime },
          );
          return {
            kind: "direct_outbound",
            bypassRiskyResponseGuard: false,
            bookingConfirmedByWhoosh: false,
            replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
            debug: {
              intent: "booking_create",
              whooshAvailabilityAttempted: true,
              whooshBookingAttempted: false,
              whooshBookingConfirmed: false,
              durationDefaulted: durationDefaultedDebug,
              requiredDetailsMissing: [],
              selectedSlotSource: "whoosh",
              reason: "square_hold_agenda_missing",
              ...smsOfferDebugNoFreshLookup,
            },
          };
        }

        const availRecheck = await whooshAvailabilityClient.getAvailability({
          serviceType: "simulator",
          date: agendaDateForRecheck,
          partySize: partySized,
          durationMinutes: durationStored,
          preferredTimeRange: facts.preferredTimePhrase ?? undefined,
        });

        if (!availRecheck.ok) {
          await emitSmsBookingAudit(
            params.supabase,
            params.conversationId,
            params.businessId,
            "sms_booking_hold_failed",
            { reason: availRecheck.error, slot: pick.startTime },
          );
          return {
            kind: "direct_outbound",
            bypassRiskyResponseGuard: false,
            bookingConfirmedByWhoosh: false,
            replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
            debug: {
              intent: "booking_create",
              whooshAvailabilityAttempted: true,
              whooshBookingAttempted: false,
              whooshBookingConfirmed: false,
              durationDefaulted: durationDefaultedDebug,
              requiredDetailsMissing: [],
              selectedSlotSource: "whoosh",
              reason: "square_hold_whoosh_availability_failed",
              ...smsOfferDebugNoFreshLookup,
            },
          };
        }

        const stillListed = availRecheck.slots.some(
          (s) =>
            s.startTime === pick.startTime &&
            s.bayOrResourceId.trim() === pick.bayOrResourceId.trim()
        );

        if (!stillListed) {
          await emitSmsBookingAudit(
            params.supabase,
            params.conversationId,
            params.businessId,
            "sms_booking_hold_failed",
            { reason: "slot_no_longer_in_whoosh_refresh", slot: pick.startTime },
          );
          return {
            kind: "direct_outbound",
            bypassRiskyResponseGuard: false,
            bookingConfirmedByWhoosh: false,
            replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
            debug: {
              intent: "booking_create",
              whooshAvailabilityAttempted: true,
              whooshBookingAttempted: false,
              whooshBookingConfirmed: false,
              durationDefaulted: durationDefaultedDebug,
              requiredDetailsMissing: [],
              selectedSlotSource: "whoosh",
              reason: "square_hold_slot_removed_on_recheck",
              ...smsOfferDebugNoFreshLookup,
            },
          };
        }

        const correlation = pickSlotCorrelationIds(pick);
        try {
          if (
            await hasActiveSimulatorHoldConflict(params.supabase, {
              businessId: params.businessId,
              bayResourceId: correlation.bayResourceId,
              slotStartIso: pick.startTime,
              slotEndIso: selectedEndTime,
            })
          ) {
            await emitSmsBookingAudit(
              params.supabase,
              params.conversationId,
              params.businessId,
              "sms_booking_hold_failed",
              { reason: "hold_collision_active", bay: correlation.bayResourceId },
            );
            return {
              kind: "direct_outbound",
              bypassRiskyResponseGuard: false,
              bookingConfirmedByWhoosh: false,
              replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
              debug: {
                intent: "booking_create",
                whooshAvailabilityAttempted: true,
                whooshBookingAttempted: false,
                whooshBookingConfirmed: false,
                durationDefaulted: durationDefaultedDebug,
                requiredDetailsMissing: [],
                selectedSlotSource: "whoosh",
                reason: "simulator_square_hold_blocked_overlap",
                ...smsOfferDebugNoFreshLookup,
              },
            };
          }

          let amountDueCents: number;
          try {
            amountDueCents = estimateSimulatorBookingUsdCents({
              partySize: partySized,
              durationMinutes: durationStored,
              slotStartIso: pick.startTime,
            });
          } catch {
            await emitSmsBookingAudit(
              params.supabase,
              params.conversationId,
              params.businessId,
              "sms_booking_hold_failed",
              { reason: "simulator_quote_failed" },
            );
            return {
              kind: "direct_outbound",
              bypassRiskyResponseGuard: false,
              bookingConfirmedByWhoosh: false,
              replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
              debug: {
                intent: "booking_create",
                whooshAvailabilityAttempted: true,
                whooshBookingAttempted: false,
                whooshBookingConfirmed: false,
                durationDefaulted: durationDefaultedDebug,
                requiredDetailsMissing: [],
                selectedSlotSource: "whoosh",
                reason: "simulator_quote_failed_before_square_hold",
                ...smsOfferDebugNoFreshLookup,
              },
            };
          }

          const holdExpiryIso = new Date(Date.now() + holdMinutes * 60 * 1000).toISOString();

          let closeosBookingId: string | null = null;
          closeosBookingId = (
            await insertCloseOsBookingHold(params.supabase, {
              business_id: params.businessId,
              conversation_id: params.conversationId,
              contact_id: params.contactId,
              agenda_date: agendaDateForRecheck,
              service_type: "simulator",
              start_time: pick.startTime,
              end_time: selectedEndTime,
              bay_id: correlation.bayResourceId,
              slot_id_external: correlation.slotIdExternal,
              party_size: partySized,
              duration_minutes: durationStored,
              slot_snapshot: jsonSnapshotForCloseOsBookingSlot(selectedSlotForBooking),
              amount_due_cents: amountDueCents,
              currency: "USD",
              payment_provider: "square",
              payment_status: "pending",
              expires_at: holdExpiryIso,
              status: "held_pending_payment",
            })
          ).id;

          let checkoutLink: Awaited<
            ReturnType<typeof squarePaymentHoldCheckoutClient.createBookingHoldCheckoutLink>
          >;
          try {
            checkoutLink =
              await squarePaymentHoldCheckoutClient.createBookingHoldCheckoutLink({
                amountDueCents,
                title: PAY_HOLD_TITLE,
                descriptionNote: `${buildPaymentHoldSquareDescriptionNote(selectedSlotForBooking)} (${partySized} players)`,
                referenceId: closeosBookingId,
                metadataStringMap: {
                  closeos_booking_id: closeosBookingId,
                  business_id: params.businessId,
                  conversation_id: params.conversationId ?? "",
                  contact_id: params.contactId ?? "",
                  slot_id:
                    correlation.slotIdExternal ??
                    correlation.bayResourceId,
                },
              });
          } catch (linkErr: unknown) {
            const msgErr =
              typeof linkErr === "object" &&
              linkErr !== null &&
              "message" in linkErr &&
              typeof (linkErr as { message: unknown }).message === "string" ?
                ((linkErr as { message: string }).message.slice(0, 500) ?? "")
              : String(linkErr).slice(0, 420);

          await updateCloseOsBookingPaymentFields(params.supabase, closeosBookingId, {
            payment_link_url: null,
            payment_link_id: null,
            status: "square_link_failed",
            last_error_summary: msgErr,
            payment_status: "pending",
            raw_payload: {
              agenda_date: agendaDateForRecheck,
              slot_id_external: correlation.slotIdExternal,
              slot_snapshot: jsonSnapshotForCloseOsBookingSlot(selectedSlotForBooking),
              square_order_id: null,
              square_checkout_creation_failed: true,
            },
            updated_at: new Date().toISOString(),
          });

            await persistBookingAction({
              supabase: params.supabase,
              businessId: params.businessId,
              conversationId: params.conversationId,
              contactId: params.contactId,
              actionType: "booking_create",
              status: "failed",
              serviceType: pick.serviceType,
              requestedDateIso: agendaDateForRecheck,
              partySize: partySized,
              durationMinutes: durationStored,
              selectedStart: pick.startTime,
              selectedEnd: selectedEndTime,
              errorMessage: msgErr.slice(0, 300),
              payload: {
                closeos_booking_id: closeosBookingId,
                simulator_square_hold: true,
                square_checkout_creation_failed: true,
              },
            });

            await emitSmsBookingAudit(
              params.supabase,
              params.conversationId,
              params.businessId,
              "sms_booking_hold_failed",
              { closeos_booking_id: closeosBookingId },
            );

            return {
              kind: "direct_outbound",
              bypassRiskyResponseGuard: false,
              bookingConfirmedByWhoosh: false,
              replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
              debug: {
                intent: "booking_create",
                whooshAvailabilityAttempted: true,
                whooshBookingAttempted: false,
                whooshBookingConfirmed: false,
                durationDefaulted: durationDefaultedDebug,
                requiredDetailsMissing: [],
                selectedSlotSource: "whoosh",
                reason: "simulator_square_checkout_creation_failed",
                ...smsOfferDebugNoFreshLookup,
              },
            };
          }

          await updateCloseOsBookingPaymentFields(params.supabase, closeosBookingId, {
            payment_link_url: checkoutLink.payment_link_url,
            payment_link_id: checkoutLink.payment_link_id,
            payment_provider: "square",
            payment_status: "pending",
            status: "held_pending_payment",
            raw_payload: {
              agenda_date: agendaDateForRecheck,
              slot_id_external: correlation.slotIdExternal,
              slot_snapshot: jsonSnapshotForCloseOsBookingSlot(selectedSlotForBooking),
              square_order_id: checkoutLink.square_order_id,
            },
            updated_at: new Date().toISOString(),
          });

          await persistBookingAction({
            supabase: params.supabase,
            businessId: params.businessId,
            conversationId: params.conversationId,
            contactId: params.contactId,
            actionType: "booking_create",
            status: "completed",
            serviceType: pick.serviceType,
            requestedDateIso: agendaDateForRecheck,
            partySize: partySized,
            durationMinutes: durationStored,
            selectedStart: pick.startTime,
            selectedEnd: selectedEndTime,
            payload: {
              closeos_booking_id: closeosBookingId,
              simulator_square_hold: true,
              payment_hold_minutes: holdMinutes,
              hold_expires_at: holdExpiryIso,
              payment_link_url: checkoutLink.payment_link_url,
              payment_provider: "square",
              square_payment_link_id: checkoutLink.payment_link_id,
              amount_due_cents: amountDueCents,
            },
          });

          await emitSmsBookingAudit(
            params.supabase,
            params.conversationId,
            params.businessId,
            "sms_booking_hold_checkout_created",
            { closeos_booking_id: closeosBookingId, hold_minutes: holdMinutes },
          );

          const paymentHoldReply = buildCloseOsSimulatorPaymentHoldOutboundSms({
            slotStartIso: pick.startTime,
            durationMinutes: durationStored,
            partySize: partySized,
            paymentLinkUrl: checkoutLink.payment_link_url,
            holdMinutes,
            resourceLabel: pick.resourceName,
            agendaDateIso: agendaDateForRecheck,
          });

          return {
            kind: "direct_outbound",
            bypassRiskyResponseGuard: false,
            bookingConfirmedByWhoosh: false,
            replyText: paymentHoldReply,
            debug: {
              intent: "booking_create",
              whooshAvailabilityAttempted: true,
              whooshBookingAttempted: false,
              whooshBookingConfirmed: false,
              durationDefaulted: durationDefaultedDebug,
              requiredDetailsMissing: [],
              selectedSlotSource: "whoosh",
              reason: "simulator_square_hold_checkout_created",
              ...smsOfferDebugNoFreshLookup,
            },
          };
        } catch (holdErr: unknown) {
          console.error("[sms-booking-flow] square hold failed:", holdErr);
          await emitSmsBookingAudit(
            params.supabase,
            params.conversationId,
            params.businessId,
            "sms_booking_hold_failed",
            {
              slot: pick.startTime,
              error_preview: holdErr instanceof Error ? holdErr.message.slice(0, 220) : "unknown_error",
            },
          );
          return {
            kind: "direct_outbound",
            bypassRiskyResponseGuard: false,
            bookingConfirmedByWhoosh: false,
            replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
            debug: {
              intent: "booking_create",
              whooshAvailabilityAttempted: true,
              whooshBookingAttempted: false,
              whooshBookingConfirmed: false,
              durationDefaulted: durationDefaultedDebug,
              requiredDetailsMissing: [],
              selectedSlotSource: "whoosh",
              reason: "simulator_square_hold_unexpected_throw",
              ...smsOfferDebugNoFreshLookup,
            },
          };
        }
      }

      const integrationWirePreview = buildWhooshIntegrationBookingWire(
        bookingCreateParams,
        memberResolved,
        { source: "closeos_sms_agent", integrationStatus: "confirmed" }
      );

      const persistPendingInsert = await persistBookingAction({
        supabase: params.supabase,
        businessId: params.businessId,
        conversationId: params.conversationId,
        contactId: params.contactId,
        actionType: "booking_create",
        status: "pending",
        serviceType: pick.serviceType,
        requestedDateIso: typeof pick.raw?.agenda_date === "string" ? pick.raw.agenda_date : facts.isoDate,
        partySize: partySized,
        durationMinutes: durationStored,
        selectedStart: pick.startTime,
        selectedEnd: selectedEndTime,
        payload: {
          offered_slot: selectedSlotForBooking,
          customer_selection_inbound: params.inboundText,
          integration_request_summary: whooshIntegrationRequestPersistSummary(integrationWirePreview),
        },
      });
      if (!persistPendingInsert.ok) {
        console.error(
          "[sms-booking-flow] booking_actions pending insert skipped:",
          persistPendingInsert.errorMessage
        );
      }

      await emitSmsBookingAudit(
        params.supabase,
        params.conversationId,
        params.businessId,
        "sms_booking_create_attempted",
        {
          slot_start: pick.startTime,
          resource_id: pick.bayOrResourceId,
        }
      );

      const result = await whooshBookingClient.createBooking(bookingCreateParams);

      if (!result.ok) {
        await persistBookingAction({
          supabase: params.supabase,
          businessId: params.businessId,
          conversationId: params.conversationId,
          contactId: params.contactId,
          actionType: "booking_create",
          status: "failed",
          serviceType: pick.serviceType,
          requestedDateIso: typeof pick.raw?.agenda_date === "string" ? pick.raw.agenda_date : facts.isoDate,
          requestedTimeRange: facts.preferredTimePhrase,
          partySize: partySized,
          durationMinutes: durationStored,
          selectedStart: pick.startTime,
          selectedEnd: selectedEndTime,
          errorMessage: result.error,
          payload: {
            inbound: params.inboundText,
            offered_slot: selectedSlotForBooking,
            integration_request_summary: whooshIntegrationRequestPersistSummary(integrationWirePreview),
            whoosh_integration_error_raw: summarizeWhooshErrorRawForBookingActions(result.raw),
            ...(result.attemptedPostPayloadSummary ?
              {
                failed_whoosh_post_payload_summary:
                  result.attemptedPostPayloadSummary,
              }
            : {}),
          },
        });
        await emitSmsBookingAudit(
          params.supabase,
          params.conversationId,
          params.businessId,
          "sms_booking_create_failed",
          { error: result.error?.slice?.(0, 400) ?? String(result.error) }
        );

        return {
          kind: "direct_outbound",
          bypassRiskyResponseGuard: false,
          bookingConfirmedByWhoosh: false,
          replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
          extraMetadata: { booking_error: result.error },
          debug: {
            intent: "booking_create",
            whooshAvailabilityAttempted: true,
            whooshBookingAttempted: true,
            whooshBookingConfirmed: false,
            durationDefaulted: durationDefaultedDebug,
            requiredDetailsMissing: [],
            selectedSlotSource: "whoosh",
            reason: "whoosh_create_booking_failed",
            ...smsOfferDebugNoFreshLookup,
          },
        };
      }

      const whooshPersistAudit =
        typeof result.raw === "object" &&
        result.raw !== null &&
        "closeos_whoosh_audit" in result.raw ?
          (result.raw as Record<string, unknown>).closeos_whoosh_audit
        : null;

      const persistCompleteInsert = await persistBookingAction({
        supabase: params.supabase,
        businessId: params.businessId,
        conversationId: params.conversationId,
        contactId: params.contactId,
        actionType: "booking_create",
        status: "completed",
        serviceType: pick.serviceType,
        requestedDateIso: typeof pick.raw?.agenda_date === "string" ? pick.raw.agenda_date : facts.isoDate,
        requestedTimeRange: facts.preferredTimePhrase,
        partySize: partySized,
        durationMinutes: durationStored,
        selectedStart: pick.startTime,
        selectedEnd: selectedEndTime,
        providerBookingId: result.bookingId,
        providerRequestId: result.requestId,
        payload: {
          inbound: params.inboundText,
          offered_slot: selectedSlotForBooking,
          outcome: result.outcome,
          whoosh_audit: whooshPersistAudit,
          confirmation_hint: result.confirmationNumber,
        },
      });
      if (!persistCompleteInsert.ok) {
        console.error(
          "[sms-booking-flow] booking_actions completed booking insert skipped:",
          persistCompleteInsert.errorMessage
        );
      }

      await emitSmsBookingAudit(
        params.supabase,
        params.conversationId,
        params.businessId,
        "sms_booking_create_succeeded",
        {
          outcome: result.outcome,
          booking_id: result.bookingId,
          provider_request_id: result.requestId,
          confirmation_hint: result.confirmationNumber,
        }
      );

      const displaySlot = formatPacSlotDisplayHuman(pick.startTime);

      /** Deliberately uses “confirmation” wording only when downstream booking_confirmed_by_whoosh marks true from Whoosh. */
      const successCopyConfirmed = `Confirmed for ${displaySlot} (${PRIMETIME_LOCATION_LINE}). Ref ${result.confirmationNumber ?? result.bookingId ?? result.requestId ?? ""}`;

      const pendingRequestCopy =
        `Your booking request is in for ${displaySlot} for ${partySized} players. We'll confirm it shortly.`;

      const replyText = result.outcome === "confirmed" ? successCopyConfirmed : pendingRequestCopy;
      const bookingConfirmedByWhoosh = result.outcome === "confirmed";

      return {
        kind: "direct_outbound",
        bypassRiskyResponseGuard: false,
        bookingConfirmedByWhoosh,
        replyText,
        debug: {
          intent: "booking_create",
          whooshAvailabilityAttempted: true,
          whooshBookingAttempted: true,
          whooshBookingConfirmed: bookingConfirmedByWhoosh,
          durationDefaulted: durationDefaultedDebug,
          requiredDetailsMissing: [],
          selectedSlotSource: "whoosh",
          reason:
            result.outcome === "confirmed" ?
              "whoosh_live_book_created"
            : "whoosh_booking_request_pending",
          ...smsOfferDebugNoFreshLookup,
        },
      };
    }

    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      bookingConfirmedByWhoosh: false,
      replyText: chooseEnumeratedOfferClarificationReply({
        offeredSlots: awaitingSlots,
        agendaDateIso: storedAvailabilityEval.agendaDateIso,
        conversationHistory: params.conversationHistory,
        durationMinutes: browseDurationMinutesForStoredOfferEval,
      }),
      debug: {
        intent: "missing_details",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: durationDefaultedDebug,
        requiredDetailsMissing: ["numeric_slot_choice"],
        selectedSlotSource: "whoosh",
        reason: "offered_slots_unrecognized_selection",
        ...smsOfferDebugNoFreshLookup,
      },
    };
  }

  if (params.playbook === "general" && !bookingCueHit) {
    return {
      kind: "none",
      debug: {
        ...smsInactiveDebug("general_playbook_without_booking_cue"),
        ...dateDebug,
      },
    };
  }

  if (bookingCueHit && effectivePlaybook === "event") {
    return {
      kind: "appendix",
      text:
        `\nHIGH_TOUCH_EVENT_BLOCK` +
        `\nBOOKING_VOICE_BAN: Never say booked/reserved/you're set/confirmed/booking-complete unless sms_booking metadata marks Whoosh POST success.` +
        `\nCustomer is planning an EVENT with ${facts.partySize ?? "UNKNOWN"} attendees.` +
        `\nRespond warmly, collect headcount/date window if missing, escalate to onsite team.` +
        `\nNever brainstorm exact times without live Whoosh context.`,
      debug: {
        intent: "missing_details",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: false,
        requiredDetailsMissing: [],
        selectedSlotSource: "none",
        reason: "event_high_touch_escalation",
        ...smsOfferDebugForLookupTrail,
      },
    };
  }

  if (!bookingCueHit) {
    return {
      kind: "none",
      debug: {
        ...smsInactiveDebug("booking_cue_not_detected"),
        ...dateDebug,
      },
    };
  }

  const missingFacts =
    facts.serviceType === "lesson"
      ? missingFactsForLesson(facts, params.contactPhone)
      : simulatorLookupMissingFields(
          facts,
          params.contactPhone,
          simulatorDurResolve.minutes ?? null
        );

  if (missingFacts.length > 0) {
    const lines = summarizeMissingQuestions(missingFacts, facts, transcript)[0]!;

    return {
      kind: "appendix",
      text:
        `\nWHOOSH_BOOKING_PRECHECK_FAILED` +
        `\nBOOKING_VOICE_BAN: Never say booked, locked in, finalized, reserved, priced, totals, confirmations, nor "seeing you then" timelines unless Whoosh booking POST succeeds (sms_booking metadata).\nNever say booked/reserved/you're set/confirmed without Whoosh POST booking success.` +
        `\nMissing BEFORE live lookup (no availability/booking APIs until cleared): ${missingFacts.join(", ")}.` +
        `\nAsk ONE question only: "${lines}". Do NOT cite exact clock hours until Whoosh_LOOKUP_SUCCESS.`,
      debug: {
        intent: "missing_details",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: false,
        requiredDetailsMissing: missingFacts,
        selectedSlotSource: "none",
        reason: "missing_whoosh_precheck_facts",
        ...smsOfferDebugForLookupTrail,
      },
    };
  }

  const lookupService: WhooshServiceType =
    facts.serviceType === "lesson" ? "lesson" : "simulator";

  const dateForLookup = facts.isoDate;
  if (!dateForLookup) {
    return {
      kind: "appendix",
      text:
        `\nWHOOSH_MISSING_DATE_GUARD` +
        `\nSafety stop: missing explicit calendar day before Whoosh.` +
        ` Ask which calendar day fits.` +
        `\nBOOKING_VOICE_BAN: Never fabricate confirmations.`,
      debug: {
        intent: "missing_details",
        whooshAvailabilityAttempted: false,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: false,
        requiredDetailsMissing: ["date"],
        selectedSlotSource: "none",
        reason: "date_guard_after_precheck_fail",
        ...smsOfferDebugForLookupTrail,
      },
    };
  }

  const browseDurationMinutes =
    facts.serviceType === "lesson" ?
      facts.lessonDurationMinutes ?? 60
    : simulatorDurResolve.minutes ?? facts.simulatorDurationMinutes ?? 60;

  await emitSmsBookingAudit(
    params.supabase,
    params.conversationId,
    params.businessId,
    "sms_booking_availability_attempted",
    {
      date: dateForLookup,
      service: lookupService,
      party_hint: facts.partySize ?? 1,
    }
  );

  const lookup = await whooshAvailabilityClient.getAvailability({
    serviceType: lookupService,
    date: dateForLookup,
    partySize: facts.partySize ?? 1,
    durationMinutes: browseDurationMinutes,
    preferredTimeRange: facts.preferredTimePhrase ?? null,
  });

  if (!lookup.ok) {
    await persistBookingAction({
      supabase: params.supabase,
      businessId: params.businessId,
      conversationId: params.conversationId,
      contactId: params.contactId,
      actionType: "availability_lookup",
      status: "failed",
      serviceType: facts.serviceType,
      requestedDateIso: dateForLookup,
      requestedTimeRange: facts.preferredTimePhrase,
      partySize: facts.partySize,
      durationMinutes: browseDurationMinutes,
      errorMessage: lookup.error,
      payload: { details: lookup.details ?? lookup.error ?? null },
    });
    await emitSmsBookingAudit(params.supabase, params.conversationId, params.businessId, "sms_booking_availability_failed", {
      code: lookup.error,
      detail: lookup.details ?? null,
    });

    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      bookingConfirmedByWhoosh: false,
      replyText:
        "I'm having trouble checking live availability right now. I can still take the details and have the team follow up.",
      extraMetadata: {
        whoosh_lookup_failed: lookup.error,
        whoosh_lookup_details: lookup.details ?? null,
      },
      debug: {
        intent: "availability_lookup",
        whooshAvailabilityAttempted: true,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: durationDefaultedDebug,
        requiredDetailsMissing: [],
        selectedSlotSource: "none",
        reason: lookup.error ?? "availability_lookup_transport_failed",
        ...smsOfferDebugForLookupTrail,
      },
    };
  }

  await emitSmsBookingAudit(params.supabase, params.conversationId, params.businessId, "sms_booking_availability_succeeded", {
    slot_count: lookup.slots.length,
    agenda_date: lookup.agenda_date,
  });

  if (lookup.slots.length === 0) {
    await persistBookingAction({
      supabase: params.supabase,
      businessId: params.businessId,
      conversationId: params.conversationId,
      contactId: params.contactId,
      actionType: "availability_lookup",
      status: "completed",
      serviceType: facts.serviceType,
      requestedDateIso: dateForLookup,
      requestedTimeRange: facts.preferredTimePhrase,
      partySize: facts.partySize,
      durationMinutes: browseDurationMinutes,
      payload: { offered_slots: [], note: "no_public_matches" },
    });

    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      bookingConfirmedByWhoosh: false,
      replyText:
        "I don't see that exact time available. Want me to check nearby times?",
      extraMetadata: { whoosh_empty_day: dateForLookup },
      debug: {
        intent: "availability_lookup",
        whooshAvailabilityAttempted: true,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: durationDefaultedDebug,
        requiredDetailsMissing: [],
        selectedSlotSource: "none",
        reason: "whoosh_inventory_empty_filtered",
        ...smsOfferDebugForLookupTrail,
      },
    };
  }

  const offeredSlots = lookup.slots.slice(0, 3);

  const offeredWire = buildStoredOfferSlots(offeredSlots);

  const persistOffer = await persistBookingAction({
    supabase: params.supabase,
    businessId: params.businessId,
    conversationId: params.conversationId,
    contactId: params.contactId,
    actionType: "availability_lookup",
    status: "completed",
    serviceType: facts.serviceType,
    requestedDateIso: dateForLookup,
    requestedTimeRange: facts.preferredTimePhrase,
    partySize: facts.partySize,
    durationMinutes: browseDurationMinutes,
    payload: {
      fetched_at_iso: lookup.fetchedAtIso,
      agenda_date: lookup.agenda_date,
      slot_rows_seen: lookup.slotRowsLoaded,
      booking_rows_seen: lookup.bookingRowsLoaded,
      offered_slots: offeredWire,
    },
  });

  if (!persistOffer.ok) {
    const msg = persistOffer.errorMessage ?? "unknown_booking_actions_error";
    return {
      kind: "direct_outbound",
      bypassRiskyResponseGuard: false,
      bookingConfirmedByWhoosh: false,
      replyText: BOOKING_CONFIRMATION_HANDOFF_REPLY,
      extraMetadata: {
        booking_actions_persist_failed: true,
        booking_actions_error_preview: msg.slice(0, 220),
      },
      debug: {
        intent: "availability_lookup",
        whooshAvailabilityAttempted: true,
        whooshBookingAttempted: false,
        whooshBookingConfirmed: false,
        durationDefaulted: durationDefaultedDebug,
        requiredDetailsMissing: [],
        selectedSlotSource: "none",
        reason: isBookingActionsPersistenceLikelyUnavailable(msg)
          ? "booking_actions_table_missing_offer_not_stored"
          : "booking_actions_insert_failed_offer_not_stored",
        ...smsOfferDebugForLookupTrail,
      },
    };
  }

  return {
    kind: "direct_outbound",
    bypassRiskyResponseGuard: false,
    bookingConfirmedByWhoosh: false,
    replyText: formatSmsSlotOffers(offeredSlots, dateForLookup, browseDurationMinutes),
    extraMetadata: {
      booking_flow_offer: true,
      whoosh_raw_matches: lookup.slots.length,
    },
    debug: {
      intent: "availability_lookup",
      whooshAvailabilityAttempted: true,
      whooshBookingAttempted: false,
      whooshBookingConfirmed: false,
      durationDefaulted: durationDefaultedDebug,
      requiredDetailsMissing: [],
      selectedSlotSource: "none",
      reason: "whoosh_slots_offered",
      ...smsOfferDebugForLookupTrail,
    },
  };
}
