/**
 * CloseOS SMS simulator booking augmentation (Whoosh snapshot + deterministic copy).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";

import { DateTime, Settings } from "luxon";

import type { ConversationHistoryMessage } from "@/lib/ai/conversation-reply-core";
import type {
  NormalizedWhooshAvailabilitySlot,
  WhooshAvailabilityParams,
} from "@/lib/whoosh/availability";
import {
  buildWhooshIntegrationBookingWire,
  emptyWhooshRawAgendaKeyPresence,
  resolveWhooshBookingMemberNumber,
  type WhooshBookingAttemptedPostPayloadSummary,
  type WhooshBookingCreateParams,
  type WhooshBookingResult,
} from "@/lib/whoosh/bookings";
import {
  BOOKING_CONFIRMATION_HANDOFF_REPLY,
} from "@/lib/ai/booking-outbound-guard";
import { estimateSimulatorBookingUsdCents } from "@/lib/primetime/simulator-quote";

import type { BookingFlowAugmentation } from "./sms-booking-flow";
import {
  customerAffirmsWithoutSlotDigitChoice,
  extractLessonDuration,
  extractSimulatorDurationMinutes,
  resolveRequestedDateFromText,
  runCloseOsSmsBookingAugmentation,
  squarePaymentHoldCheckoutClient,
  whooshAvailabilityClient,
  whooshBookingClient,
} from "./sms-booking-flow";

type DirectOutboundAugmentation = Extract<BookingFlowAugmentation, { kind: "direct_outbound" }>;

function expectDirectOutbound(flow: BookingFlowAugmentation): DirectOutboundAugmentation {
  assert.strictEqual(flow.kind, "direct_outbound");
  return flow;
}

function whooshBookingOk(
  overrides: Partial<Exclude<WhooshBookingResult, { ok: false }>> &
    Pick<Exclude<WhooshBookingResult, { ok: false }>, "startTime" | "endTime">
): Exclude<WhooshBookingResult, { ok: false }> {
  return {
    ok: true,
    outcome: "confirmed",
    bookingId: "mock-booking-id",
    requestId: null,
    confirmationNumber: "mock-confirmation",
    raw: {},
    ...overrides,
  };
}

/** Prior inbound SMS lines merged like production so follow-ups keep party/date context. */
function inboundOnlyHistory(lines: string[]): ConversationHistoryMessage[] {
  const t0 = Date.now();
  return lines.map((message_text, i) => ({
    direction: "inbound",
    channel: "sms",
    message_text,
    status: null,
    created_at: new Date(t0 + i).toISOString(),
  }));
}

const sampleSlot = (): NormalizedWhooshAvailabilitySlot => ({
  startTime: "2035-06-04T01:30:00.000Z",
  endTime: "2035-06-04T02:30:00.000Z",
  bayOrResourceId: "vendor-slot-771",
  resourceName: "Bay A",
  serviceType: "simulator",
  priceEstimate: "~$35/hr",
  raw: { agenda_date: "2035-06-03" },
});

/** 11:00 / 11:15 / 11:30 PT on 2035-06-17 (matches live prompt style). */

function sampleBaySlots1100Thru1130Jun17(): NormalizedWhooshAvailabilitySlot[] {
  const commonRaw = {
    agenda_date: "2035-06-17",
    facility_slug: "simulators",
    course_id: "fc56dd17-ad78-4861-983b-bf7ec7d3233c",
  };
  return [
    {
      startTime: "2035-06-17T18:00:00.000Z",
      endTime: "2035-06-17T19:00:00.000Z",
      bayOrResourceId: "whoosh-slot-1100",
      resourceName: "Bay 1",
      serviceType: "simulator",
      priceEstimate: null,
      raw: { ...commonRaw, id: "473d2db9-f503-4dec-9afe-cdf8b029db8e" },
    },
    {
      startTime: "2035-06-17T18:15:00.000Z",
      endTime: "2035-06-17T19:15:00.000Z",
      bayOrResourceId: "whoosh-slot-1115",
      resourceName: "Bay 1",
      serviceType: "simulator",
      priceEstimate: null,
      raw: { ...commonRaw, id: "473d2db9-f503-4dec-9afe-cdf8b029db8d" },
    },
    {
      startTime: "2035-06-17T18:30:00.000Z",
      endTime: "2035-06-17T19:30:00.000Z",
      bayOrResourceId: "whoosh-slot-1130",
      resourceName: "Bay 1",
      serviceType: "simulator",
      priceEstimate: null,
      raw: { ...commonRaw, id: "473d2db9-f503-4dec-9afe-cdf8b029db8f" },
    },
  ];
}

/** Matches `buildStoredOfferSlots` shape for seeding `booking_actions` in tests. */
function wireStoredOffersFromBaySlots(
  slots: NormalizedWhooshAvailabilitySlot[]
): Array<{
  option_index: number;
  startTime: string;
  endTime: string;
  bayOrResourceId: string;
  resourceName: string | null;
  priceEstimate: string | null;
  serviceType: string;
  raw: Record<string, unknown>;
}> {
  return slots.map((slot, i) => ({
    option_index: i + 1,
    startTime: slot.startTime,
    endTime: slot.endTime,
    bayOrResourceId: slot.bayOrResourceId,
    resourceName: slot.resourceName ?? null,
    priceEstimate: slot.priceEstimate ?? null,
    serviceType:
      slot.serviceType === "lesson" ? "lesson"
      : slot.serviceType === "event" ? "event"
      : "simulator",
    raw: slot.raw ?? {},
  }));
}

class FakeBookingSupabase {
  rows: Record<string, unknown>[] = [];
  closeos_bookings_rows: Record<string, unknown>[] = [];
  /** When set, simulates Postgres/PostgREST insert failures (missing table). */
  insertBookingErrorMessage: string | null = null;

  from(table: string) {
    if (table === "audit_logs") {
      return {
        insert: async () => ({ error: null }),
      };
    }

    if (table === "closeos_bookings") {
      const store = this;
      return {
        insert: (payload: Record<string, unknown>) => {
          const id =
            typeof payload.id === "string" && payload.id.trim() ? payload.id : randomUUID();
          const row = {
            ...payload,
            id,
            updated_at: new Date().toISOString(),
          };
          store.closeos_bookings_rows.push(row);
          return {
            select(_cols?: string) {
              return {
                single: async () => ({ data: { id }, error: null }),
              };
            },
          };
        },

        update: (patch: Record<string, unknown>) => ({
          eq: (field: string, val: unknown) =>
            Promise.resolve((async () => {
              const idx = store.closeos_bookings_rows.findIndex((r) => r[field] === val);
              if (idx >= 0) {
                Object.assign(store.closeos_bookings_rows[idx], patch, {
                  updated_at: new Date().toISOString(),
                });
              }
              return { error: null };
            })()),
        }),

        select(_cols?: string) {
          const filt: {
            pairs: Record<string, unknown>;
            ins: Record<string, string[]>;
          } = {
            pairs: {},
            ins: {},
          };

          const builder = {
            eq(field: string, val: unknown) {
              filt.pairs[field] = val;
              return builder;
            },
            in(field: string, vals: string[]) {
              filt.ins[field] = vals;
              return Promise.resolve({ data: filterRows(store.closeos_bookings_rows), error: null });
            },
            maybeSingle: async () => ({
              data: filterRows(store.closeos_bookings_rows)[0] ?? null,
              error: null,
            }),
          };

          function filterRows(all: Record<string, unknown>[]) {
            return all.filter((r) => {
              const okPairs = Object.entries(filt.pairs).every(([k, v]) => r[k] === v);
              if (!okPairs) return false;

              const stIn = filt.ins.status;
              if (stIn && stIn.length) {
                if (!stIn.includes(String(r.status ?? ""))) return false;
              }

              const metaInEntries = Object.entries(filt.ins).filter(([kk]) => kk !== "status");
              for (const [kk, vv] of metaInEntries) {
                const v = r[kk];
                if (!vv.includes(String(v ?? ""))) return false;
              }
              return true;
            });
          }

          return builder;
        },
      };
    }

    assert.strictEqual(table, "booking_actions");
    const store = this;
    return {
      insert: async (row: Record<string, unknown>) => {
        if (store.insertBookingErrorMessage) {
          return { error: { message: store.insertBookingErrorMessage } };
        }
        const created_at =
          typeof row.created_at === "string" ? row.created_at : new Date().toISOString();
        store.rows.push({ ...row, created_at });
        return { error: null };
      },
      select(_cols: string) {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq(field: string, val: unknown) {
            filters[field] = val;
            return chain;
          },
          order(_field: string, _opts?: { ascending: boolean }) {
            return chain;
          },
          limit(_n: number) {
            return chain;
          },
          maybeSingle: async (): Promise<{ data: Record<string, unknown> | null; error: null }> => {
            const hit = [...store.rows].reverse().find((r) =>
              Object.entries(filters).every(([key, val]) => r[key] === val)
            );
            return hit ? { data: hit, error: null } : { data: null, error: null };
          },
        };
        return chain;
      },
    };
  }
}

describe("sms-booking-flow", () => {
  const savedAvail = whooshAvailabilityClient.getAvailability.bind(whooshAvailabilityClient);
  const savedBook = whooshBookingClient.createBooking.bind(whooshBookingClient);
  const savedHoldCheckoutCreate = squarePaymentHoldCheckoutClient.createBookingHoldCheckoutLink.bind(
    squarePaymentHoldCheckoutClient
  );
  const savedBookingEnabled = process.env.WHOOSH_BOOKING_API_ENABLED;
  const savedBookingPath = process.env.WHOOSH_BOOKING_POST_PATH;
  const savedGuestMn = process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
  const savedDefaultHoles = process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
  const savedDefaultTransport = process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
  const savedDateTimeMode = process.env.WHOOSH_BOOKING_DATETIME_MODE;
  const savedCloseOsPayRequired = process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS;
  const savedCloseOsHoldMin = process.env.CLOSEOS_BOOKING_HOLD_MINUTES;
  const savedSettingsNow = Settings.now;

  /**
   * Guest member fallback for booking POST — live uses `WHOOSH_BOOKING_GUEST_MEMBER_NUMBER`; tests default it.
   */
  beforeEach(() => {
    /** Default OFF so legacy simulator Whoosh-live tests behave unchanged unless a nested suite enables payment holds. */
    process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS = "false";
    delete process.env.CLOSEOS_BOOKING_HOLD_MINUTES;

    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER =
      typeof savedGuestMn === "string" && savedGuestMn.trim() ?
        savedGuestMn
      : "sms-flow-test-guest";
    if (savedDefaultHoles !== undefined)
      process.env.WHOOSH_BOOKING_DEFAULT_HOLES = savedDefaultHoles;
    else delete process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
    if (savedDefaultTransport !== undefined)
      process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = savedDefaultTransport;
    else delete process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
    if (savedDateTimeMode !== undefined)
      process.env.WHOOSH_BOOKING_DATETIME_MODE = savedDateTimeMode;
    else delete process.env.WHOOSH_BOOKING_DATETIME_MODE;
  });

  afterEach(() => {
    whooshAvailabilityClient.getAvailability = savedAvail;
    whooshBookingClient.createBooking = savedBook;
    squarePaymentHoldCheckoutClient.createBookingHoldCheckoutLink = savedHoldCheckoutCreate;

    process.env.WHOOSH_BOOKING_API_ENABLED = savedBookingEnabled;
    process.env.WHOOSH_BOOKING_POST_PATH = savedBookingPath;
    if (savedGuestMn === undefined) delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
    else process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = savedGuestMn;
    if (savedDefaultHoles === undefined) delete process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
    else process.env.WHOOSH_BOOKING_DEFAULT_HOLES = savedDefaultHoles;
    if (savedDefaultTransport === undefined)
      delete process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
    else process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = savedDefaultTransport;
    if (savedDateTimeMode === undefined) delete process.env.WHOOSH_BOOKING_DATETIME_MODE;
    else process.env.WHOOSH_BOOKING_DATETIME_MODE = savedDateTimeMode;

    if (savedCloseOsPayRequired === undefined) delete process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS;
    else process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS = savedCloseOsPayRequired;
    if (savedCloseOsHoldMin === undefined) delete process.env.CLOSEOS_BOOKING_HOLD_MINUTES;
    else process.env.CLOSEOS_BOOKING_HOLD_MINUTES = savedCloseOsHoldMin;
    Settings.now = savedSettingsNow;
  });

  async function runAugment(input: {
    inboundText: string;
    playbook: string;
    conversationHistory?: ConversationHistoryMessage[];
    sb?: FakeBookingSupabase;
    conversationId?: string;
    contactId?: string | null;
    simulatorBayDefaultDurationMinutes?: number | null;
    contactMemberNumber?: string | null;
  }) {
    const sb = input.sb ?? new FakeBookingSupabase();
    const flow = await runCloseOsSmsBookingAugmentation({
      supabase: sb as never,
      businessId: "00000000-0000-0000-0000-000000000099",
      conversationId: input.conversationId ?? "00000000-0000-4000-a000-000000000001",
      contactId: input.contactId ?? "00000000-0000-4000-a000-000000000002",
      contactName: "Pat",
      contactPhone: "+15551231234",
      inboundText: input.inboundText,
      playbook: input.playbook,
      conversationHistory: input.conversationHistory ?? [],
      simulatorBayDefaultDurationMinutes: input.simulatorBayDefaultDurationMinutes,
      contactMemberNumber:
        typeof input.contactMemberNumber === "string" ? input.contactMemberNumber : null,
    });
    return { flow, sb };
  }

  test("Thursday from 2026-05-17 resolves to the upcoming Thursday in Pacific time", () => {
    const anchor = DateTime.fromISO("2026-05-17T12:00:00", {
      zone: "America/Los_Angeles",
    });

    const resolved = resolveRequestedDateFromText(
      "Thursday for 2 people for 2 hours",
      anchor
    );

    assert.strictEqual(resolved.isoDate, "2026-05-21");
    assert.strictEqual(resolved.source, "explicit_weekday");
  });

  test("simulator duration phrases resolve deterministically", () => {
    assert.strictEqual(extractSimulatorDurationMinutes("Thursday for 2 people for 2 hours"), 120);
    assert.strictEqual(extractSimulatorDurationMinutes("Thursday for two hours"), 120);
    assert.strictEqual(extractSimulatorDurationMinutes("Thursday for 2 hrs"), 120);
    assert.strictEqual(extractSimulatorDurationMinutes("Thursday for 90 minutes"), 90);
    assert.strictEqual(extractSimulatorDurationMinutes("Thursday for 1 hour"), 60);
    assert.strictEqual(
      extractSimulatorDurationMinutes("Friday evening for 2 players for 1/2 hour"),
      30
    );
    assert.strictEqual(extractSimulatorDurationMinutes("1/2hr bay time"), 30);
  });

  test("slash half-hour is not January 2 and is 30 minutes not 2 hours", () => {
    const anchor = DateTime.fromISO("2026-05-17T12:00:00", {
      zone: "America/Los_Angeles",
    });
    assert.strictEqual(
      resolveRequestedDateFromText(
        "Book simulator Friday evening for 2 players for 1/2 hour",
        anchor
      ).isoDate,
      "2026-05-22"
    );
    assert.strictEqual(
      resolveRequestedDateFromText("adult lesson Friday evening 1/2 hour", anchor).isoDate,
      "2026-05-22"
    );
    assert.strictEqual(
      resolveRequestedDateFromText("Friday evening 9/18 holes for 2 players", anchor).isoDate,
      "2026-05-22"
    );
    assert.strictEqual(resolveRequestedDateFromText("9/18", anchor).isoDate, "2026-09-18");
    assert.strictEqual(extractLessonDuration("adult lesson Friday evening for 1/2 hour"), 30);
    assert.strictEqual(extractLessonDuration("60 minute lesson"), 60);
  });

  test("latest inbound explicit weekday overrides stored offer date", async () => {
    const fixedNowMs = 1_779_047_200_000;
    Settings.now = () => fixedNowMs;

    const conv = "00000000-0000-4000-a000-00000000d471";
    const sb = new FakeBookingSupabase();
    const biz = "00000000-0000-0000-0000-000000000099";
    const cid = "00000000-0000-4000-a000-000000000002";

    sb.rows.push({
      business_id: biz,
      conversation_id: conv,
      contact_id: cid,
      provider: "whoosh",
      action_type: "availability_lookup",
      status: "completed",
      service_type: "simulator",
      requested_date: "2026-05-20",
      party_size: 2,
      duration_minutes: 120,
      raw_payload: {
        agenda_date: "2026-05-20",
        offered_slots: wireStoredOffersFromBaySlots(sampleBaySlots1100Thru1130Jun17()),
      },
      created_at: new Date().toISOString(),
    });

    const seen: WhooshAvailabilityParams[] = [];
    whooshAvailabilityClient.getAvailability = async (p) => {
      seen.push(p);
      return {
        ok: true,
        slots: [],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: p.date,
        slotRowsLoaded: 0,
        bookingRowsLoaded: 0,
      };
    };

    const { flow } = await runAugment({
      inboundText: "Thursday morning for 2 people for 2 hours book a bay",
      playbook: "simulator",
      conversationId: conv,
      contactId: cid,
      sb,
    });

    assert.deepStrictEqual(seen.map((p) => p.date), ["2026-05-21"]);
    assert.deepStrictEqual(seen.map((p) => p.durationMinutes), [120]);
    const out = expectDirectOutbound(flow);
    assert.strictEqual(out.debug.resolved_requested_date, "2026-05-21");
    assert.strictEqual(out.debug.date_source, "explicit_weekday");
    assert.strictEqual(out.debug.timezone, "America/Los_Angeles");
    assert.strictEqual(out.debug.usingStoredOfferSlots, false);
    assert.strictEqual(out.debug.storedOfferRejectedReason, "superseded_by_new_booking_request");
  });

  test("Wednesday and Thursday resolve distinctly and latest inbound wins over history", async () => {
    const anchor = DateTime.fromISO("2026-05-17T12:00:00", {
      zone: "America/Los_Angeles",
    });
    assert.strictEqual(resolveRequestedDateFromText("Wednesday", anchor).isoDate, "2026-05-20");
    assert.strictEqual(resolveRequestedDateFromText("Thursday", anchor).isoDate, "2026-05-21");

    const fixedNowMs = anchor.toMillis();
    Settings.now = () => fixedNowMs;

    const seenDates: string[] = [];
    whooshAvailabilityClient.getAvailability = async (p) => {
      seenDates.push(p.date);
      return {
        ok: true,
        slots: [],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: p.date,
        slotRowsLoaded: 0,
        bookingRowsLoaded: 0,
      };
    };

    await runAugment({
      inboundText: "Thursday morning for 2 people for 2 hours book a bay",
      playbook: "simulator",
      conversationHistory: inboundOnlyHistory([
        "Wednesday morning for 2 people for 2 hours book a bay",
      ]),
    });

    assert.deepStrictEqual(seenDates, ["2026-05-21"]);
  });

  test("1/2 hour SMS looks up Friday at 30 minutes not January 2 at 2 hours", async () => {
    const anchor = DateTime.fromISO("2026-05-17T12:00:00", {
      zone: "America/Los_Angeles",
    });
    Settings.now = () => anchor.toMillis();

    const seen: WhooshAvailabilityParams[] = [];
    whooshAvailabilityClient.getAvailability = async (p) => {
      seen.push(p);
      return {
        ok: true,
        slots: [],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: p.date,
        slotRowsLoaded: 0,
        bookingRowsLoaded: 0,
      };
    };

    await runAugment({
      inboundText:
        "Book simulator Friday evening for 2 players for 1/2 hour bay reserve schedule please",
      playbook: "simulator",
    });

    assert.deepStrictEqual(seen.map((p) => p.date), ["2026-05-22"]);
    assert.deepStrictEqual(seen.map((p) => p.durationMinutes), [30]);
    assert.notDeepStrictEqual(seen.map((p) => p.date), ["2026-01-02"]);
    assert.notDeepStrictEqual(seen.map((p) => p.durationMinutes), [120]);
  });

  test("Saturday evening interest without player count never calls Whoosh for exact times", async () => {
    let called = false;
    whooshAvailabilityClient.getAvailability = async () => {
      called = true;
      return {
        ok: true,
        slots: [sampleSlot()],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-08",
        slotRowsLoaded: 1,
        bookingRowsLoaded: 0,
      };
    };

    const { flow } = await runAugment({
      inboundText: "Can you book a simulator Sat evening for practice bay schedule hold",
      playbook: "simulator",
    });

    assert.strictEqual(called, false);
    assert.strictEqual(flow.kind, "appendix");
    assert.match(flow.text, /player_count/);
    assert.ok(!/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i.test(flow.text));
  });

  test("Whoosh returns evening slots before quoting exact clock times", async () => {
    const seen: WhooshAvailabilityParams[] = [];
    whooshAvailabilityClient.getAvailability = async (p) => {
      seen.push(p);
      return {
        ok: true,
        slots: [sampleSlot()],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-03",
        slotRowsLoaded: 4,
        bookingRowsLoaded: 0,
      };
    };

    const { flow } = await runAugment({
      inboundText:
        "Book simulator 2035-06-03 evening solo practice 1 hour bay reserve schedule please",
      playbook: "simulator",
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].preferredTimeRange, "evening");
    const outbound = expectDirectOutbound(flow);
    assert.ok(/see.*available|6:30\sPM/i.test(outbound.replyText));
  });

  test("affirmations without slot digits never create bookings", async () => {
    const conv = "00000000-0000-4000-a000-00000000caf1";
    const sb = new FakeBookingSupabase();
    let createCalls = 0;

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: [sampleSlot()],
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-03",
      slotRowsLoaded: 10,
      bookingRowsLoaded: 0,
    });

    whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> => {
      createCalls += 1;
      return whooshBookingOk({
        bookingId: "x",
        confirmationNumber: "y",
        startTime: "2035-06-04T01:30:00.000Z",
        endTime: "2035-06-04T02:30:00.000Z",
        raw: {},
      });
    };

    await runAugment({
      inboundText:
        "Book simulator bay 2035-06-03 evening solo myself 90 minutes reserve schedule booking",
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    assert.ok(customerAffirmsWithoutSlotDigitChoice("yeah that's correct"));
    const followUp = await runAugment({
      inboundText: "yeah that's correct",
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    assert.strictEqual(createCalls, 0);
    assert.match(expectDirectOutbound(followUp.flow).replyText, /Reply 1,/i);
  });

  test("explicit clock text without enumerated pick does not call createBooking", async () => {
    const conv = "00000000-0000-4000-a000-00000000caf9";
    const sb = new FakeBookingSupabase();
    let createCalls = 0;

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: [sampleSlot()],
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-03",
      slotRowsLoaded: 12,
      bookingRowsLoaded: 0,
    });

    whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> => {
      createCalls += 1;
      return whooshBookingOk({
        bookingId: "z",
        confirmationNumber: "z",
        startTime: "2035-06-04T01:30:00.000Z",
        endTime: "2035-06-04T02:30:00.000Z",
        raw: {},
      });
    };

    await runAugment({
      inboundText:
        "Book simulator 2035-06-03 evening bay solo hour booking reserve simulator please",
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    await runAugment({
      inboundText: "6:30 pm works great",
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    assert.strictEqual(createCalls, 0);
  });

  test("Whoosh booking success sets bookingConfirmedByWhoosh for gateway guard", async () => {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";

    const conv = "00000000-0000-4000-a000-00000000dde1";
    const sb = new FakeBookingSupabase();

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: [sampleSlot()],
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-03",
      slotRowsLoaded: 5,
      bookingRowsLoaded: 0,
    });

    whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> =>
      whooshBookingOk({
        bookingId: "BOOK-900",
        confirmationNumber: "C-900",
        startTime: "2035-06-04T01:30:00.000Z",
        endTime: "2035-06-04T02:30:00.000Z",
        raw: {},
      });

    const bookingSeed =
      "Book simulator 2035-06-03 evening bay solo hourly myself reserve simulator booking yes";

    await runAugment({
      inboundText: bookingSeed,
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    const sel = await runAugment({
      inboundText: "1",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([bookingSeed]),
    });

    const booked = expectDirectOutbound(sel.flow);
    assert.strictEqual(booked.bookingConfirmedByWhoosh, true);
    assert.match(booked.replyText, /Confirmed for/i);
  });

  test("Whoosh booking failure sends confirmation handoff without celebration", async () => {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";

    const conv = "00000000-0000-4000-a000-00000000dde2";
    const sb = new FakeBookingSupabase();

    let availCalls = 0;
    whooshAvailabilityClient.getAvailability = async () => {
      availCalls += 1;
      return {
        ok: true,
        slots: [sampleSlot()],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-03",
        slotRowsLoaded: 10,
        bookingRowsLoaded: 0,
      };
    };

    whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> => ({
      ok: false,
      error: "UNIT_TEST_REJECT",
    });

    const bookingSeed =
      "Book simulator 2035-06-03 afternoon bay solo hourly myself reserve simulator booking";

    await runAugment({
      inboundText: bookingSeed,
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    const sel = await runAugment({
      inboundText: "1",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([bookingSeed]),
    });

    assert.strictEqual(availCalls, 1);
    const failed = expectDirectOutbound(sel.flow);
    assert.strictEqual(failed.replyText, BOOKING_CONFIRMATION_HANDOFF_REPLY);
    assert.strictEqual(failed.bookingConfirmedByWhoosh, false);
  });

  test("pricing FAQ still bypasses booking orchestration telemetry", async () => {
    const { flow } = await runAugment({
      inboundText: "How much is a bay?",
      playbook: "general",
    });
    assert.strictEqual(expectDirectOutbound(flow).debug.intent, "pricing");
    assert.strictEqual(expectDirectOutbound(flow).debug.durationDefaulted, false);
  });

  test("Sunday morning bay for two triggers Whoosh with 60m default duration (no transcript duration)", async () => {
    const seen: WhooshAvailabilityParams[] = [];
    whooshAvailabilityClient.getAvailability = async (p) => {
      seen.push(p);
      return {
        ok: true,
        slots: [sampleSlot()],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-03",
        slotRowsLoaded: 1,
        bookingRowsLoaded: 0,
      };
    };

    const { flow } = await runAugment({
      inboundText:
        "I want to book a bay on 2035-06-03 Sunday morning for two players reservation",
      playbook: "simulator",
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].durationMinutes, 60);
    assert.strictEqual(seen[0].partySize, 2);
    assert.strictEqual(flow.kind, "direct_outbound");
    assert.strictEqual(expectDirectOutbound(flow).debug.durationDefaulted, true);
    assert.strictEqual(expectDirectOutbound(flow).debug.whooshAvailabilityAttempted, true);
    assert.strictEqual(expectDirectOutbound(flow).debug.requiredDetailsMissing.length, 0);
  });

  test("explicit clock in follow-up prefers 11am for Whoosh preferredTimeRange while defaulting bay duration", async () => {
    const seed =
      "I want to book a bay 2035-06-03 Sunday morning for two players reservation";
    const seen: WhooshAvailabilityParams[] = [];
    whooshAvailabilityClient.getAvailability = async (p) => {
      seen.push(p);
      return {
        ok: true,
        slots: [sampleSlot()],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-03",
        slotRowsLoaded: 4,
        bookingRowsLoaded: 0,
      };
    };

    const { flow } = await runAugment({
      inboundText: `I'm thinking 11am`,
      playbook: "simulator",
      conversationHistory: inboundOnlyHistory([seed]),
    });

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].durationMinutes, 60);
    assert.match(String(seen[0].preferredTimeRange ?? ""), /^11am$/i);
    assert.strictEqual(expectDirectOutbound(flow).debug.durationDefaulted, true);
    assert.strictEqual(expectDirectOutbound(flow).debug.whooshAvailabilityAttempted, true);
  });

  test("with default duration disabled, precheck asks for bay duration (not coarse time refinement only)", async () => {
    const { flow } = await runAugment({
      inboundText:
        "I want to book a bay on 2035-06-03 Sunday morning for two players reservation",
      playbook: "simulator",
      simulatorBayDefaultDurationMinutes: null,
    });

    assert.strictEqual(flow.kind, "appendix");
    assert.match(flow.text, /duration_minutes/);
    assert.match(flow.text, /Roughly how long would you like the bay — 30 minutes, 1 hour, or 2 hours/);
    assert.ok(!/\bMorning, afternoon, or evening\b/.test(flow.text));
  });

  test("when default disabled and customer adds explicit time, appendix asks concise duration follow-up", async () => {
    const seed =
      "I want to book a bay on 2035-06-03 Sunday morning for two players reservation";
    let availCalls = 0;
    whooshAvailabilityClient.getAvailability = async () => {
      availCalls += 1;
      return {
        ok: true,
        slots: [sampleSlot()],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-03",
        slotRowsLoaded: 1,
        bookingRowsLoaded: 0,
      };
    };

    const { flow } = await runAugment({
      inboundText: `I'm thinking 11am`,
      playbook: "simulator",
      conversationHistory: inboundOnlyHistory([seed]),
      simulatorBayDefaultDurationMinutes: null,
    });

    assert.strictEqual(availCalls, 0);
    assert.strictEqual(flow.kind, "appendix");
    assert.ok(flow.debug.requiredDetailsMissing.includes("duration_minutes"));
    assert.match(flow.text, /Got it — roughly how long would you like the bay for\?/);
  });

  test("availability_completed booking_action stores enumerated offered_slots for follow-up UX", async () => {
    const conv = "00000000-0000-4000-a000-00000000e101";
    const sb = new FakeBookingSupabase();
    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: sampleBaySlots1100Thru1130Jun17(),
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-17",
      slotRowsLoaded: 6,
      bookingRowsLoaded: 0,
    });

    await runAugment({
      inboundText:
        "I want to book simulator bay 2035-06-17 morning for two players hourly reservation booking",
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    const availRow = sb.rows.find((r) => String(r.action_type) === "availability_lookup");
    assert.ok(availRow, "expected availability_lookup row");
    const payload = availRow!.raw_payload as { offered_slots: Array<{ option_index: number; startTime: string }> };
    assert.ok(Array.isArray(payload.offered_slots) && payload.offered_slots.length === 3);
    assert.strictEqual(payload.offered_slots[0].option_index, 1);
    assert.strictEqual(payload.offered_slots[2].option_index, 3);
    assert.strictEqual(payload.offered_slots[2].startTime, "2035-06-17T18:30:00.000Z");
  });

  test("offer follow-up selects third slot via reply 3 and calls createBooking", async () => {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";

    const conv = "00000000-0000-4000-a000-00000000e102";
    const sb = new FakeBookingSupabase();

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: sampleBaySlots1100Thru1130Jun17(),
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-17",
      slotRowsLoaded: 15,
      bookingRowsLoaded: 0,
    });

    let bookedArgs: WhooshBookingCreateParams | undefined;

    whooshBookingClient.createBooking = async (payload: WhooshBookingCreateParams) => {
      bookedArgs = payload;
      return whooshBookingOk({
        bookingId: "bk-311",
        confirmationNumber: "C-311",
        startTime: "2035-06-17T18:30:00.000Z",
        endTime: "2035-06-17T19:30:00.000Z",
        raw: {},
      });
    };

    const seed =
      "I want to book simulator bay 2035-06-17 morning for two players hourly reservation booking";
    await runAugment({
      inboundText: seed,
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    const sel = await runAugment({
      inboundText: "3",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([seed]),
    });

    assert.ok(bookedArgs, "expected createBooking");
    assert.strictEqual(bookedArgs!.selectedSlot.startTime, "2035-06-17T18:30:00.000Z");
    assert.strictEqual(bookedArgs!.selectedSlot.bayOrResourceId.trim(), "whoosh-slot-1130");

    const mr = resolveWhooshBookingMemberNumber(bookedArgs!);
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) throw new Error("expected member resolution");

    const wire = buildWhooshIntegrationBookingWire(bookedArgs!, mr);
    assert.strictEqual(wire.facility_slug, "simulators");
    assert.strictEqual(wire.agenda_date, "2035-06-17");
    assert.strictEqual(wire.slot_id, "473d2db9-f503-4dec-9afe-cdf8b029db8f");
    assert.strictEqual(wire.course_id, "fc56dd17-ad78-4861-983b-bf7ec7d3233c");
    assert.strictEqual(wire.players, 2);
    assert.strictEqual(wire.totalPlayerCount, 2);
    assert.strictEqual(wire.dateTime, "2035-06-17T18:30:00.000Z");
    assert.strictEqual(wire.start_time, wire.dateTime);
    assert.strictEqual(wire.duration, 60);
    assert.strictEqual(wire.source, "closeos_sms_agent");
    assert.strictEqual(wire.status, "confirmed");
    assert.strictEqual(wire.memberNumber, "sms-flow-test-guest");
    assert.strictEqual(wire.holes, "18");
    assert.strictEqual(wire.transportation, "cart");
    const booked = expectDirectOutbound(sel.flow);
    assert.strictEqual(booked.bookingConfirmedByWhoosh, true);
  });

  test("offer follow-up resolves 11:30 phrasing against stored slots", async () => {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";

    const conv = "00000000-0000-4000-a000-00000000e103";
    const sb = new FakeBookingSupabase();

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: sampleBaySlots1100Thru1130Jun17(),
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-17",
      slotRowsLoaded: 20,
      bookingRowsLoaded: 0,
    });

    let picks: Array<{ bayOrResourceId: string }> = [];

    whooshBookingClient.createBooking = async (payload: WhooshBookingCreateParams) => {
      picks.push({ bayOrResourceId: payload.selectedSlot.bayOrResourceId });
      return whooshBookingOk({
        bookingId: "bk-930",
        confirmationNumber: "C-930",
        startTime: payload.selectedSlot.startTime,
        endTime: payload.selectedSlot.endTime,
        raw: {},
      });
    };

    const seed =
      "I want to book simulator bay 2035-06-17 morning two players hourly reservation booking";
    await runAugment({ inboundText: seed, playbook: "simulator", conversationId: conv, sb });

    await runAugment({
      inboundText: "11:30 is good",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([seed]),
    });

    assert.strictEqual(picks.length, 1);
    assert.strictEqual(picks[0]?.bayOrResourceId.trim(), "whoosh-slot-1130");

    await runAugment({
      inboundText: "I want to book 11:15 am thanks",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([seed, "11:30 is good"]),
    });
    assert.strictEqual(picks.length, 2);
    assert.strictEqual(picks[1]?.bayOrResourceId.trim(), "whoosh-slot-1115");
  });

  test("fresh booking wording ignores recent stored offers and runs a new availability lookup", async () => {
    const conv = "00000000-0000-4000-a000-00000000e1f0";
    const sb = new FakeBookingSupabase();
    const biz = "00000000-0000-0000-0000-000000000099";
    const cid = "00000000-0000-4000-a000-000000000002";

    sb.rows.push({
      business_id: biz,
      conversation_id: conv,
      contact_id: cid,
      provider: "whoosh",
      action_type: "availability_lookup",
      status: "completed",
      service_type: "simulator",
      requested_date: "2035-06-17",
      party_size: 2,
      duration_minutes: 60,
      raw_payload: {
        agenda_date: "2035-06-17",
        offered_slots: wireStoredOffersFromBaySlots(sampleBaySlots1100Thru1130Jun17()),
      },
      created_at: new Date().toISOString(),
    });

    const dates: string[] = [];
    whooshAvailabilityClient.getAvailability = async (p) => {
      dates.push(p.date);
      return {
        ok: true,
        slots: sampleBaySlots1100Thru1130Jun17(),
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-18",
        slotRowsLoaded: 8,
        bookingRowsLoaded: 0,
      };
    };

    const { flow } = await runAugment({
      inboundText:
        "I want to book a bay Sunday morning on 2035-06-18 for 2 hours for 2 players reservation booking",
      playbook: "simulator",
      conversationId: conv,
      contactId: cid,
      sb,
    });

    assert.strictEqual(dates.length, 1);
    assert.strictEqual(dates[0], "2035-06-18");

    const outbound = expectDirectOutbound(flow);
    assert.ok(
      /\b11:\d{2}\s*(?:AM|PM)|available|Reply\s+1,/i.test(outbound.replyText),
      `expected slot copy in reply: ${outbound.replyText}`
    );
    assert.match(outbound.replyText, /2 hours|11:00 AM-1:00 PM/i);
    assert.ok(!/openings i just sent/i.test(outbound.replyText));
    assert.strictEqual(outbound.debug.latestInboundIsNewBookingRequest, true);
    assert.strictEqual(outbound.debug.usingStoredOfferSlots, false);
    assert.strictEqual(outbound.debug.storedOfferRejectedReason, "superseded_by_new_booking_request");
    assert.strictEqual(outbound.debug.reason, "whoosh_slots_offered");
  });

  test("reply 2 after stale stored offer asks to re-check instead of team handoff", async () => {
    const conv = "00000000-0000-4000-a000-00000000e1f2";
    const sb = new FakeBookingSupabase();
    const biz = "00000000-0000-0000-0000-000000000099";
    const cid = "00000000-0000-4000-a000-000000000002";
    const seed =
      "I want to book simulator bay 2035-06-17 morning for two players hourly reservation booking";

    sb.rows.push({
      business_id: biz,
      conversation_id: conv,
      contact_id: cid,
      provider: "whoosh",
      action_type: "availability_lookup",
      status: "completed",
      service_type: "simulator",
      requested_date: "2035-06-17",
      party_size: 2,
      duration_minutes: 60,
      raw_payload: {
        agenda_date: "2035-06-17",
        offered_slots: wireStoredOffersFromBaySlots(sampleBaySlots1100Thru1130Jun17()),
      },
      created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    });

    const { flow } = await runAugment({
      inboundText: "2",
      playbook: "simulator",
      conversationId: conv,
      contactId: cid,
      sb,
      conversationHistory: inboundOnlyHistory([seed]),
    });

    const out = expectDirectOutbound(flow);
    assert.strictEqual(
      out.replyText,
      "I don't want to guess on an old set of times. What day and time should I check for you?"
    );
    assert.strictEqual(out.debug.latestInboundIsSlotPick, true);
    assert.strictEqual(out.debug.foundStoredOffer, true);
    assert.strictEqual(out.debug.storedOfferRejectedReason, "stored_offer_expired (>10min)");
    assert.strictEqual(out.debug.contactMatch, true);
    assert.strictEqual(out.debug.conversationMatch, true);
    assert.strictEqual(out.debug.requestedDateMatch, true);
    assert.ok((out.debug.offerAgeSeconds ?? 0) >= 600);
  });

  test("reply 2 from different contact does not use another contact's offer", async () => {
    const conv = "00000000-0000-4000-a000-00000000e1f3";
    const sb = new FakeBookingSupabase();
    const biz = "00000000-0000-0000-0000-000000000099";
    const otherCid = "00000000-0000-4000-a000-000000000099";
    const thisCid = "00000000-0000-4000-a000-000000000002";
    const seed =
      "I want to book simulator bay 2035-06-17 morning for two players hourly reservation booking";

    sb.rows.push({
      business_id: biz,
      conversation_id: conv,
      contact_id: otherCid,
      provider: "whoosh",
      action_type: "availability_lookup",
      status: "completed",
      service_type: "simulator",
      requested_date: "2035-06-17",
      party_size: 2,
      duration_minutes: 60,
      raw_payload: {
        agenda_date: "2035-06-17",
        offered_slots: wireStoredOffersFromBaySlots(sampleBaySlots1100Thru1130Jun17()),
      },
      created_at: new Date().toISOString(),
    });

    const { flow } = await runAugment({
      inboundText: "2",
      playbook: "simulator",
      conversationId: conv,
      contactId: thisCid,
      sb,
      conversationHistory: inboundOnlyHistory([seed]),
    });

    const out = expectDirectOutbound(flow);
    assert.strictEqual(
      out.replyText,
      "I don't want to guess on an old set of times. What day and time should I check for you?"
    );
    assert.strictEqual(out.debug.latestInboundIsSlotPick, true);
    assert.strictEqual(out.debug.foundStoredOffer, false);
    assert.strictEqual(out.debug.storedOfferRejectedReason, "no_stored_offer_row");
    assert.strictEqual(sb.closeos_bookings_rows.length, 0);
  });

  test("stored offers older than 10 minutes are ignored; reply 3 does not book from stale snapshot", async () => {
    const conv = "00000000-0000-4000-a000-00000000e1f1";
    const sb = new FakeBookingSupabase();
    const biz = "00000000-0000-0000-0000-000000000099";
    const cid = "00000000-0000-4000-a000-000000000002";

    const staleCreated = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    sb.rows.push({
      business_id: biz,
      conversation_id: conv,
      contact_id: cid,
      provider: "whoosh",
      action_type: "availability_lookup",
      status: "completed",
      service_type: "simulator",
      requested_date: "2035-06-17",
      party_size: 2,
      duration_minutes: 60,
      raw_payload: {
        agenda_date: "2035-06-17",
        offered_slots: wireStoredOffersFromBaySlots(sampleBaySlots1100Thru1130Jun17()),
      },
      created_at: staleCreated,
    });

    let availCalls = 0;
    let createCalls = 0;

    whooshAvailabilityClient.getAvailability = async () => {
      availCalls += 1;
      return {
        ok: true,
        slots: sampleBaySlots1100Thru1130Jun17(),
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-17",
        slotRowsLoaded: 6,
        bookingRowsLoaded: 0,
      };
    };

    whooshBookingClient.createBooking = async () => {
      createCalls += 1;
      return whooshBookingOk({
        bookingId: "stale-should-not-hit",
        confirmationNumber: "X",
        startTime: "2035-06-17T18:30:00.000Z",
        endTime: "2035-06-17T19:30:00.000Z",
        raw: {},
      });
    };

    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";

    const seed =
      "I want to book simulator bay 2035-06-17 morning for two players hourly reservation booking";
    const sel = await runAugment({
      inboundText: "3",
      playbook: "simulator",
      conversationId: conv,
      contactId: cid,
      sb,
      conversationHistory: inboundOnlyHistory([seed]),
    });

    assert.strictEqual(availCalls, 0);
    assert.strictEqual(createCalls, 0);
    assert.strictEqual(sel.flow.kind, "direct_outbound");

    const outbound = expectDirectOutbound(sel.flow);
    assert.strictEqual(
      outbound.replyText,
      "I don't want to guess on an old set of times. What day and time should I check for you?"
    );
    assert.strictEqual(outbound.debug.storedOfferRejectedReason, "stored_offer_expired (>10min)");
    assert.strictEqual(outbound.debug.reason, "numeric_slot_pick_without_valid_stored_offer");
  });

  test("Whoosh booking does not POST when guest member env and contact member are absent", async () => {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";
    delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;

    const conv = "00000000-0000-4000-a000-00000000e10f";
    const sb = new FakeBookingSupabase();
    let createCalls = 0;

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: [sampleSlot()],
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-03",
      slotRowsLoaded: 4,
      bookingRowsLoaded: 0,
    });

    whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> => {
      createCalls += 1;
      return whooshBookingOk({
        bookingId: "x",
        confirmationNumber: "y",
        startTime: sampleSlot().startTime,
        endTime: sampleSlot().endTime,
      });
    };

    const bookingSeed =
      "Book simulator 2035-06-03 evening bay solo hourly myself reserve simulator booking yes";

    await runAugment({
      inboundText: bookingSeed,
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    const sel = await runAugment({
      inboundText: "1",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([bookingSeed]),
      contactMemberNumber: null,
    });

    assert.strictEqual(createCalls, 0);
    const out = expectDirectOutbound(sel.flow);
    assert.strictEqual(out.replyText, BOOKING_CONFIRMATION_HANDOFF_REPLY);
    assert.strictEqual(out.debug.reason, "whoosh_booking_guest_member_unconfigured");
  });

  test("Whoosh pending outcome uses request copy and stores provider_request_id", async () => {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";

    const conv = "00000000-0000-4000-a000-00000000e105";
    const sb = new FakeBookingSupabase();

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: [sampleSlot()],
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-03",
      slotRowsLoaded: 4,
      bookingRowsLoaded: 0,
    });

    whooshBookingClient.createBooking = async () =>
      whooshBookingOk({
        outcome: "pending",
        bookingId: null,
        requestId: "whoosh-req-pend-1",
        confirmationNumber: "whoosh-req-pend-1",
        startTime: "2035-06-04T01:30:00.000Z",
        endTime: "2035-06-04T02:30:00.000Z",
        raw: {
          request_id: "whoosh-req-pend-1",
          closeos_whoosh_audit: {
            integration_request_summary: { slot_id: "vendor-slot-771" },
            integration_response_summary: { outcome: "pending" },
          },
        },
      });

    const bookingSeed =
      "Book simulator 2035-06-03 evening bay solo hourly myself reserve simulator booking yes";

    await runAugment({
      inboundText: bookingSeed,
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    const sel = await runAugment({
      inboundText: "1",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([bookingSeed]),
    });

    const booked = expectDirectOutbound(sel.flow);
    assert.strictEqual(booked.bookingConfirmedByWhoosh, false);
    assert.match(booked.replyText, /booking request is in for/i);
    assert.ok(!booked.replyText.toLowerCase().includes("confirmed for"));

    const completes = sb.rows.filter(
      (r) => String(r.action_type) === "booking_create" && String(r.status) === "completed"
    );
    assert.ok(completes.length >= 1);
    const lastComplete = completes.at(-1)! as Record<string, unknown>;
    assert.strictEqual(lastComplete.provider_request_id, "whoosh-req-pend-1");
    assert.ok(
      lastComplete.provider_booking_id === null || lastComplete.provider_booking_id === undefined
    );
  });

  test("Whoosh rejection inserts booking_create failed with error_message and request summary", async () => {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/fake-booking-path";

    const postAudit: WhooshBookingAttemptedPostPayloadSummary = {
      transportation: "cart",
      holes: "18",
      memberNumberPresent: true,
      dateTime: sampleSlot().startTime,
      totalPlayerCount: 1,
      agenda_date: "2035-06-03",
      facility_slug: "simulators",
      course_id: null,
      slot_id: "vendor-slot-771",
      bay_id: "vendor-slot-771",
      raw_date: "2035-06-03",
      raw_time: null,
      whoosh_booking_datetime_mode: "iso_offset",
      agenda_id_present: false,
      whoosh_raw_agenda_key_presence: emptyWhooshRawAgendaKeyPresence(),
    };

    const conv = "00000000-0000-4000-a000-00000000e106";
    const sb = new FakeBookingSupabase();

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: [sampleSlot()],
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-03",
      slotRowsLoaded: 4,
      bookingRowsLoaded: 0,
    });

    whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> => ({
      ok: false,
      error: "Whoosh booking HTTP 422: {\"message\":\"bad\"}",
      raw: { message: "bad" },
      attemptedPostPayloadSummary: postAudit,
    });

    const bookingSeed =
      "Book simulator 2035-06-03 evening bay solo hourly myself reserve simulator booking yes";

    await runAugment({
      inboundText: bookingSeed,
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    await runAugment({
      inboundText: "1",
      playbook: "simulator",
      conversationId: conv,
      sb,
      conversationHistory: inboundOnlyHistory([bookingSeed]),
    });

    const failed = sb.rows.filter(
      (r) => String(r.action_type) === "booking_create" && String(r.status) === "failed"
    );
    assert.ok(failed.length >= 1);
    const lastFailed = failed.at(-1)! as Record<string, unknown>;
    assert.match(String(lastFailed.error_message ?? ""), /422|Whoosh/);
    const pay = lastFailed.raw_payload as {
      integration_request_summary?: { bay_id?: string };
      failed_whoosh_post_payload_summary?: typeof postAudit;
    };
    assert.strictEqual(pay.integration_request_summary?.bay_id, "vendor-slot-771");
    assert.deepStrictEqual(pay.failed_whoosh_post_payload_summary, postAudit);
  });

  test("booking_actions insert failure swaps to team handoff without slot offer copy", async () => {
    const conv = "00000000-0000-4000-a000-00000000e104";
    const sb = new FakeBookingSupabase();
    sb.insertBookingErrorMessage =
      "Could not find the table 'public.booking_actions' in the schema cache";

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: sampleBaySlots1100Thru1130Jun17(),
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-17",
      slotRowsLoaded: 99,
      bookingRowsLoaded: 0,
    });

    const { flow } = await runAugment({
      inboundText:
        "Book simulator bay 2035-06-17 Sunday morning solo myself hourly simulator booking reservation",
      playbook: "simulator",
      conversationId: conv,
      sb,
    });

    const out = expectDirectOutbound(flow);
    assert.strictEqual(out.replyText, BOOKING_CONFIRMATION_HANDOFF_REPLY);
    assert.ok(!/I see .* available/i.test(out.replyText));
    assert.strictEqual(out.debug.reason, "booking_actions_table_missing_offer_not_stored");
  });

  describe("simulator_square_payment_holds_(non_members)", () => {
    beforeEach(() => {
      process.env.WHOOSH_BOOKING_API_ENABLED = "true";
      process.env.WHOOSH_BOOKING_POST_PATH = "/integration/api/booking_request_fixture";
      process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS = "true";
      process.env.CLOSEOS_BOOKING_HOLD_MINUTES = "10";

      squarePaymentHoldCheckoutClient.createBookingHoldCheckoutLink = async (args) => {
        assert.ok(args.amountDueCents > 0);
        return {
          payment_link_url: `https://square.test/checkout/demo?amount=${args.amountDueCents}`,
          payment_link_id: `plink_fixture_${args.referenceId}`,
          square_order_id: `ord_fixture_${args.referenceId}`,
        };
      };
    });

    afterEach(() => {
      whooshBookingClient.createBooking = savedBook;
      squarePaymentHoldCheckoutClient.createBookingHoldCheckoutLink = savedHoldCheckoutCreate;
    });

    test("non-member simulator slot reply issues Square payment link instead of posting Whoosh first", async () => {
      const conv = "00000000-0000-4000-a100-000000000301";
      const sb = new FakeBookingSupabase();
      process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-hold-fixture";

      const slots = sampleBaySlots1100Thru1130Jun17();
      const availabilityDurations: number[] = [];

      whooshAvailabilityClient.getAvailability = async (p) => {
        availabilityDurations.push(p.durationMinutes);
        return {
          ok: true,
          slots,
          fetchedAtIso: new Date().toISOString(),
          agenda_date: "2035-06-17",
          slotRowsLoaded: slots.length,
          bookingRowsLoaded: 0,
        };
      };

      let whooshBookingCalls = 0;
      whooshBookingClient.createBooking = async (p) => {
        whooshBookingCalls += 1;
        return whooshBookingOk({
          startTime: p.selectedSlot.startTime,
          endTime: p.selectedSlot.endTime,
          bookingId: "should-not-hit",
          confirmationNumber: "x",
        });
      };

      const bookingSeed =
        "Book simulator 2035-06-17 Sunday morning solo myself for 2 hours simulator booking reservation";

      await runAugment({
        inboundText: bookingSeed,
        playbook: "simulator",
        conversationId: conv,
        sb,
      });

      const sel = await runAugment({
        inboundText: "1",
        playbook: "simulator",
        conversationId: conv,
        sb,
        conversationHistory: inboundOnlyHistory([bookingSeed]),
      });

      const out = expectDirectOutbound(sel.flow);
      assert.deepStrictEqual(availabilityDurations, [120, 120]);
      assert.strictEqual(whooshBookingCalls, 0, "Whoosh POST must wait for Square webhook");
      assert.strictEqual(out.bookingConfirmedByWhoosh, false);
      assert.ok(out.replyText.includes("Perfect"), out.replyText);
      assert.ok(out.replyText.includes("https://square.test/checkout/demo"), out.replyText);
      assert.match(out.replyText, /2 hours|11:00 AM-1:00 PM/i);
      assert.strictEqual(out.debug.reason, "simulator_square_hold_checkout_created");

      assert.ok(sb.closeos_bookings_rows.length >= 1);
      const lastHold = sb.closeos_bookings_rows.at(-1)!;
      assert.strictEqual(lastHold.status, "held_pending_payment");
      assert.strictEqual(lastHold.payment_status, "pending");
      assert.strictEqual(lastHold.payment_provider, "square");
      assert.strictEqual(lastHold.duration_minutes, 120);
      assert.strictEqual(lastHold.end_time, "2035-06-17T20:00:00.000Z");
      assert.ok(typeof lastHold.payment_link_url === "string" && String(lastHold.payment_link_url).startsWith("https://square.test/checkout/demo"));

      const bookingCreates = sb.rows.filter(
        (r) => String(r.action_type) === "booking_create" && String(r.status) === "completed"
      );
      const payHold = bookingCreates.at(-1)! as Record<string, unknown>;
      assert.strictEqual(Boolean((payHold.raw_payload as { simulator_square_hold?: boolean }).simulator_square_hold), true);
      assert.strictEqual(payHold.duration_minutes, 120);
      const expectedTwoHourCents = estimateSimulatorBookingUsdCents({
        partySize: 1,
        durationMinutes: 120,
        slotStartIso: slots[0]!.startTime,
      });
      const expectedOneHourCents = estimateSimulatorBookingUsdCents({
        partySize: 1,
        durationMinutes: 60,
        slotStartIso: slots[0]!.startTime,
      });
      assert.strictEqual(expectedTwoHourCents, expectedOneHourCents * 2);
      assert.strictEqual(
        (payHold.raw_payload as { amount_due_cents?: number }).amount_due_cents,
        expectedTwoHourCents
      );
      assert.ok(String(lastHold.payment_link_url).includes(`amount=${expectedTwoHourCents}`));
    });

    test("reply 2 after valid offer creates payment hold", async () => {
      const conv = "00000000-0000-4000-a100-000000000304";
      const sb = new FakeBookingSupabase();
      process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-hold-fixture";

      const slots = sampleBaySlots1100Thru1130Jun17();
      whooshAvailabilityClient.getAvailability = async () => ({
        ok: true,
        slots,
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-17",
        slotRowsLoaded: slots.length,
        bookingRowsLoaded: 0,
      });

      const bookingSeed =
        "Book simulator 2035-06-17 Sunday morning solo myself hourly simulator booking reservation";

      await runAugment({
        inboundText: bookingSeed,
        playbook: "simulator",
        conversationId: conv,
        sb,
      });

      const sel = await runAugment({
        inboundText: "2",
        playbook: "simulator",
        conversationId: conv,
        sb,
        conversationHistory: inboundOnlyHistory([bookingSeed]),
      });

      const out = expectDirectOutbound(sel.flow);
      assert.strictEqual(out.debug.latestInboundIsSlotPick, true);
      assert.strictEqual(out.debug.foundStoredOffer, true);
      assert.strictEqual(out.debug.contactMatch, true);
      assert.strictEqual(out.debug.conversationMatch, true);
      assert.strictEqual(out.debug.storedOfferRejectedReason, null);
      assert.strictEqual(out.debug.reason, "simulator_square_hold_checkout_created");
      assert.ok(out.replyText.includes("https://square.test/checkout/demo"), out.replyText);

      const lastHold = sb.closeos_bookings_rows.at(-1)!;
      assert.strictEqual(lastHold.status, "held_pending_payment");
      assert.strictEqual(lastHold.bay_id, "whoosh-slot-1115");
      assert.strictEqual(lastHold.duration_minutes, 60);
    });

    test("concurrent inbound from another phone does not overwrite test phone offer", async () => {
      const conv = "00000000-0000-4000-a100-000000000305";
      const sb = new FakeBookingSupabase();
      const biz = "00000000-0000-0000-0000-000000000099";
      const testCid = "00000000-0000-4000-a000-000000000002";
      const otherCid = "00000000-0000-4000-a000-000000000099";
      process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-hold-fixture";

      const testSlots = sampleBaySlots1100Thru1130Jun17();
      const otherSlots = sampleBaySlots1100Thru1130Jun17().map((slot, i) => ({
        ...slot,
        bayOrResourceId: `other-phone-slot-${i + 1}`,
        raw: { ...slot.raw, id: `other-phone-slot-${i + 1}` },
      }));

      sb.rows.push({
        business_id: biz,
        conversation_id: conv,
        contact_id: testCid,
        provider: "whoosh",
        action_type: "availability_lookup",
        status: "completed",
        service_type: "simulator",
        requested_date: "2035-06-17",
        party_size: 1,
        duration_minutes: 60,
        raw_payload: {
          agenda_date: "2035-06-17",
          offered_slots: wireStoredOffersFromBaySlots(testSlots),
        },
        created_at: new Date(Date.now() - 60 * 1000).toISOString(),
      });
      sb.rows.push({
        business_id: biz,
        conversation_id: conv,
        contact_id: otherCid,
        provider: "whoosh",
        action_type: "availability_lookup",
        status: "completed",
        service_type: "simulator",
        requested_date: "2035-06-17",
        party_size: 1,
        duration_minutes: 60,
        raw_payload: {
          agenda_date: "2035-06-17",
          offered_slots: wireStoredOffersFromBaySlots(otherSlots),
        },
        created_at: new Date().toISOString(),
      });

      whooshAvailabilityClient.getAvailability = async () => ({
        ok: true,
        slots: testSlots,
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-17",
        slotRowsLoaded: testSlots.length,
        bookingRowsLoaded: 0,
      });

      const seed =
        "Book simulator 2035-06-17 Sunday morning solo myself hourly simulator booking reservation";
      const sel = await runAugment({
        inboundText: "2",
        playbook: "simulator",
        conversationId: conv,
        contactId: testCid,
        sb,
        conversationHistory: inboundOnlyHistory([seed]),
      });

      const out = expectDirectOutbound(sel.flow);
      assert.strictEqual(out.debug.reason, "simulator_square_hold_checkout_created");
      assert.strictEqual(out.debug.foundStoredOffer, true);
      assert.strictEqual(out.debug.contactMatch, true);
      const lastHold = sb.closeos_bookings_rows.at(-1)!;
      assert.strictEqual(lastHold.bay_id, "whoosh-slot-1115");
      assert.notStrictEqual(lastHold.bay_id, "other-phone-slot-2");
    });

    test("overlap with an unpaid active hold skips Square link and escalates team handoff", async () => {
      const conv = "00000000-0000-4000-a100-000000000302";
      const sb = new FakeBookingSupabase();

      /** Active overlapping hold seeded before slot pick */
      const slot = sampleBaySlots1100Thru1130Jun17()[0]!;
      sb.closeos_bookings_rows.push({
        id: "00000000-0000-0000-0001-100000002203",
        business_id: "00000000-0000-0000-0000-000000000099",
        bay_id: slot.bayOrResourceId.trim(),
        status: "held_pending_payment",
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        start_time: slot.startTime,
        end_time: slot.endTime,
        conversation_id: null,
      });

      const slots = sampleBaySlots1100Thru1130Jun17();
      whooshAvailabilityClient.getAvailability = async () => ({
        ok: true,
        slots,
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-17",
        slotRowsLoaded: slots.length,
        bookingRowsLoaded: 0,
      });

      let whooshBookingCalls = 0;
      whooshBookingClient.createBooking = async () => {
        whooshBookingCalls += 1;
        throw new Error("should_not_post_whoosh");
      };

      const bookingSeed =
        "Book simulator 2035-06-17 Sunday morning solo myself hourly simulator booking reservation";

      await runAugment({
        inboundText: bookingSeed,
        playbook: "simulator",
        conversationId: conv,
        sb,
      });

      const sel = await runAugment({
        inboundText: "1",
        playbook: "simulator",
        conversationId: conv,
        sb,
        conversationHistory: inboundOnlyHistory([bookingSeed]),
      });

      const out = expectDirectOutbound(sel.flow);
      assert.strictEqual(out.replyText, BOOKING_CONFIRMATION_HANDOFF_REPLY);
      assert.strictEqual(out.debug.reason, "simulator_square_hold_blocked_overlap");
      assert.strictEqual(whooshBookingCalls, 0);

      /** No checkout client side effects required — still ensure no stray new held rows beyond seed */
      const held = sb.closeos_bookings_rows.filter(
        (r) =>
          String(r.status) === "held_pending_payment" &&
          typeof r.start_time === "string" &&
          r.start_time === slot.startTime
      );
      assert.strictEqual(held.length, 1);
    });

    test("Square checkout creation failure swaps to booked handoff and marks square_link_failed", async () => {
      squarePaymentHoldCheckoutClient.createBookingHoldCheckoutLink = async () => {
        throw new Error("square_checkout_test_failure_preview");
      };

      const conv = "00000000-0000-4000-a100-000000000303";
      const sb = new FakeBookingSupabase();

      const slots = sampleBaySlots1100Thru1130Jun17();
      whooshAvailabilityClient.getAvailability = async () => ({
        ok: true,
        slots,
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-17",
        slotRowsLoaded: slots.length,
        bookingRowsLoaded: 0,
      });

      const bookingSeed =
        "Book simulator 2035-06-17 Sunday morning solo myself hourly simulator booking reservation";

      await runAugment({
        inboundText: bookingSeed,
        playbook: "simulator",
        conversationId: conv,
        sb,
      });

      const sel = await runAugment({
        inboundText: "1",
        playbook: "simulator",
        conversationId: conv,
        sb,
        conversationHistory: inboundOnlyHistory([bookingSeed]),
      });

      const out = expectDirectOutbound(sel.flow);
      assert.strictEqual(out.replyText, BOOKING_CONFIRMATION_HANDOFF_REPLY);
      assert.strictEqual(out.debug.reason, "simulator_square_checkout_creation_failed");

      const broke = sb.closeos_bookings_rows.filter((r) => String(r.status) === "square_link_failed");
      assert.ok(broke.length >= 1);
    });
  });
});
