/** Booking augmentation phase used by Sent.dm inbound loop shares Whoosh safeguards with `/api/ai/respond`. */
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  whooshAvailabilityClient,
  whooshBookingClient,
} from "@/lib/ai/sms-booking-flow";
import type {
  NormalizedWhooshAvailabilitySlot,
} from "@/lib/whoosh/availability";
import type { WhooshBookingResult } from "@/lib/whoosh/bookings";

import { runInboundSmsBookingAugmentationPhase } from "./inbound-sms-booking-phase";

const CID = "00000000-0000-4000-a000-00000000f001";
const BID = "00000000-0000-4000-a000-00000000f099";
const PID = "00000000-0000-4000-a000-00000000f042";

function sortByCreatedAtDesc(rows: Record<string, unknown>[]) {
  return [...rows].sort((a, b) =>
    String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
  );
}

function messagingSupabaseMock(params: {
  descRows: Record<string, unknown>[];
  audits: Record<string, unknown>[];
}) {
  return {
    from(table: string) {
      if (table === "audit_logs") {
        return {
          insert: async (row: Record<string, unknown>) => {
            params.audits.push(row as never);
            return { error: null };
          },
        };
      }
      if (table === "messages") {
        return messagesSelectFake(params.descRows);
      }
      if (table === "booking_actions") {
        return {
          insert: async () => ({ error: null }),
          select() {
            const empty = {
              eq() {
                return empty;
              },
              order() {
                return empty;
              },
              limit() {
                return empty;
              },
              maybeSingle: async () => ({ data: null, error: null }),
            };
            return empty;
          },
        };
      }
      if (table === "closeos_bookings") {
        return {
          select(_cols: string) {
            return {
              eq(_field: string, _val: unknown) {
                return {
                  eq(_field2: string, _val2: unknown) {
                    return {
                      in(_statusField: string, _vals: string[]) {
                        return Promise.resolve({ data: [], error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected_table_${table}`);
    },
  };
}

function messagesSelectFake(rowsAll: Record<string, unknown>[]) {
  return {
    select(_cols: string) {
      let conversationIdFilter = "";

      const chain: {
        eq: (field: string, val: unknown) => typeof chain;
        order: (
          _field: string,
          _opts?: { ascending: boolean }
        ) => typeof chain;
        limit: (_n?: number) => Promise<{ data: unknown; error: null }>;
      } = {
        eq(field: string, val: unknown) {
          if (field === "conversation_id") conversationIdFilter = String(val ?? "");
          return chain;
        },
        order() {
          return chain;
        },
        async limit(limitN?: number): Promise<{ data: unknown; error: null }> {
          const sliced =
            conversationIdFilter ?
              rowsAll.filter((row) => row.conversation_id === conversationIdFilter)
            : [];
          const data = sortByCreatedAtDesc(sliced).slice(0, limitN ?? sliced.length);

          return { data, error: null };
        },
      };

      return chain;
    },
  };
}

function createSentDmSupabaseBookingCapture(params: {
  descRows: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  bookingSeed: Record<string, unknown>[];
}): {
  supabase: ReturnType<typeof messagingSupabaseMock>;
  snapshotBookingRows: () => Record<string, unknown>[];
} {
  const bookingRows = [...params.bookingSeed];

  const supabase = {
    from(table: string) {
      if (table === "audit_logs") {
        return {
          insert: async (row: Record<string, unknown>) => {
            params.audits.push(row as never);
            return { error: null };
          },
        };
      }
      if (table === "messages") {
        return messagesSelectFake(params.descRows);
      }
      if (table === "booking_actions") {
        return {
          insert: async (row: Record<string, unknown>) => {
            const created_at =
              typeof row.created_at === "string" ? row.created_at : new Date().toISOString();
            bookingRows.push({ ...row, created_at });
            return { error: null };
          },
          select(_cols: string) {
            const filters: Record<string, unknown> = {};
            const chain = {
              eq(field: string, val: unknown) {
                filters[field] = val;
                return chain;
              },
              order() {
                return chain;
              },
              limit() {
                return chain;
              },
              maybeSingle: async () => {
                const hit = [...bookingRows].reverse().find((r) =>
                  Object.entries(filters).every(([key, val]) => r[key] === val)
                );
                return hit ? { data: hit, error: null } : { data: null, error: null };
              },
            };
            return chain;
          },
        };
      }
      if (table === "closeos_bookings") {
        return {
          select(_cols: string) {
            return {
              eq(_field: string, _val: unknown) {
                return {
                  eq(_field2: string, _val2: unknown) {
                    return {
                      in(_statusField: string, _vals: string[]) {
                        return Promise.resolve({ data: [], error: null });
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected_table_${table}`);
    },
  };

  return {
    supabase: supabase as never,
    snapshotBookingRows: () => [...bookingRows],
  };
}



describe("inbound-sms-booking-phase", () => {
  const savedAvail = whooshAvailabilityClient.getAvailability.bind(
    whooshAvailabilityClient
  );
  const savedBook = whooshBookingClient.createBooking.bind(whooshBookingClient);

  afterEach(() => {
    whooshAvailabilityClient.getAvailability = savedAvail;
    whooshBookingClient.createBooking = savedBook;
  });

  test("loads conversation history descending then merges prior party/date context for newest availability ask", async () => {
    let availCalls = 0;
    const sampleSlot = (): NormalizedWhooshAvailabilitySlot => ({
      startTime: "2035-06-16T03:30:00.000Z",
      endTime: "2035-06-16T04:30:00.000Z",
      bayOrResourceId: "whoosh-slot-99",
      resourceName: "Bay A",
      serviceType: "simulator",
      priceEstimate: null,
      raw: { agenda_date: "2035-06-15" },
    });

    whooshAvailabilityClient.getAvailability = async () => {
      availCalls += 1;
      return {
        ok: true,
        slots: [sampleSlot()],
        fetchedAtIso: new Date().toISOString(),
        agenda_date: "2035-06-15",
        slotRowsLoaded: 9,
        bookingRowsLoaded: 0,
      };
    };

    const descRows = [
      {
        conversation_id: CID,
        direction: "inbound",
        channel: "sms",
        message_text: "Do you have 6pm available sunday for sim bay?",
        status: "received",
        created_at: "2035-06-09T03:05:15.000Z",
      },
      {
        conversation_id: CID,
        direction: "inbound",
        channel: "sms",
        message_text:
          "Want to reserve indoor sim bay 2035-06-15 evening for 2 players 60 minutes bay booking yes",
        status: "received",
        created_at: "2035-06-09T03:00:00.000Z",
      },
    ];

    const audits: Record<string, unknown>[] = [];
    const supabase = messagingSupabaseMock({ descRows, audits }) as never;

    const inboundText = String(descRows[0]?.message_text ?? "");

    const { smsBookingFlow, conversationHistory } =
      await runInboundSmsBookingAugmentationPhase({
        supabase,
        conversationId: CID,
        businessId: BID,
        contactId: PID,
        contactName: null,
        contactPhone: "+15551234567",
        inboundText,
        ingestSource: "unit_test_phase",
      });

    assert.strictEqual(availCalls, 1);

    assert.ok(
      audits.some((a) => String(a.event_type) === "sms_booking_flow_started"),
      "expected sms_booking_flow_started audit row"
    );

    const mergedAscending = [...conversationHistory];
    const transcript = [...mergedAscending.map((m) => m.message_text ?? ""), inboundText]
      .join("\n")
      .toLowerCase();
    assert.ok(/\b2\s+players\b/i.test(transcript));
    assert.ok(transcript.includes("2035-06-15"));

    assert.strictEqual(smsBookingFlow.debug.whooshAvailabilityAttempted, true);

    /** Without a numbered slot confirm we should not falsely mark Whoosh-confirmed bookings. */
    assert.strictEqual(
      smsBookingFlow.kind === "direct_outbound" ?
        !!(smsBookingFlow as { bookingConfirmedByWhoosh?: boolean }).bookingConfirmedByWhoosh
      : false,
      false
    );
  });

  test("direct deterministic reply path would skip OpenAI (flag via flow kind)", async () => {
    whooshAvailabilityClient.getAvailability = async () => ({
      ok: false,
      error: "offline",
    });

    const audits: Record<string, unknown>[] = [];
    const supabase = messagingSupabaseMock({
      descRows: [],
      audits,
    }) as never;

    const phase = await runInboundSmsBookingAugmentationPhase({
      supabase,
      conversationId: CID,
      businessId: BID,
      contactId: null,
      contactName: null,
      contactPhone: "+15559876543",
      inboundText: "How much is a bay?",
      ingestSource: "pricing_probe",
    });

    assert.strictEqual(phase.smsBookingFlow.kind, "direct_outbound");
    assert.strictEqual(phase.smsBookingFlow.debug.intent, "pricing");
  });

  test("Sent.dm inbound phase persists full integration_request_summary on booking POST (parity with POST wire)", async () => {
    const savedEnabled = process.env.WHOOSH_BOOKING_API_ENABLED;
    const savedPath = process.env.WHOOSH_BOOKING_POST_PATH;
    const savedGuestMn = process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
    const savedHoles = process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
    const savedTransport = process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
    const savedPaymentHoldRequired = process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS;

    try {
    process.env.WHOOSH_BOOKING_API_ENABLED = "true";
    process.env.WHOOSH_BOOKING_POST_PATH = "/integration/api/booking_request_fixture";
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "sentdm-phase-guest";
    process.env.WHOOSH_BOOKING_DEFAULT_HOLES = "18";
    process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = "none";
    process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS = "false";

    let createCalls = 0;
    whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> => {
      createCalls += 1;
      return { ok: false, error: "sentdm_phase_fixture_whoosh_transport" };
    };

    const slot = (): NormalizedWhooshAvailabilitySlot => ({
      startTime: "2035-06-15T02:30:00.000Z",
      endTime: "2035-06-15T03:30:00.000Z",
      bayOrResourceId: "whoosh-slot-sdm-z9",
      resourceName: "Bay Z",
      serviceType: "simulator",
      priceEstimate: null,
      raw: {
        agenda_date: "2035-06-15",
        facility_slug: "simulators",
        course_id: "fc56dd17-ad78-4861-983b-bf7ec7d3233c",
        id: "slot-id-sentdm-phase",
      },
    });
    const s = slot();

    whooshAvailabilityClient.getAvailability = async () => ({
      ok: true,
      slots: [slot()],
      fetchedAtIso: new Date().toISOString(),
      agenda_date: "2035-06-15",
      slotRowsLoaded: 1,
      bookingRowsLoaded: 0,
    });

    const offered_wire = [
      {
        option_index: 1,
        startTime: s.startTime,
        endTime: s.endTime,
        bayOrResourceId: s.bayOrResourceId,
        resourceName: s.resourceName,
        priceEstimate: null,
        serviceType: "simulator",
        raw: s.raw ?? {},
      },
    ];

    const preloadAvailability = {
      business_id: BID,
      conversation_id: CID,
      contact_id: PID,
      provider: "whoosh",
      action_type: "availability_lookup",
      status: "completed",
      service_type: "simulator",
      requested_date: "2035-06-15",
      party_size: 2,
      duration_minutes: 60,
      raw_payload: {
        agenda_date: "2035-06-15",
        offered_slots: offered_wire,
      },
      created_at: new Date().toISOString(),
    };

    const seedMessage =
      "Book simulator bay 2035-06-15 evening for 2 players 60 minutes reservation booking reserve";
    const descRows = [
      {
        conversation_id: CID,
        direction: "inbound",
        channel: "sms",
        message_text: seedMessage,
        status: "received",
        created_at: "2035-06-09T03:00:05.000Z",
      },
    ];

    const audits: Record<string, unknown>[] = [];
    const { supabase, snapshotBookingRows } = createSentDmSupabaseBookingCapture({
      descRows,
      audits,
      bookingSeed: [preloadAvailability],
    });

    const phaseOut = await runInboundSmsBookingAugmentationPhase({
      supabase: supabase as never,
      conversationId: CID,
      businessId: BID,
      contactId: PID,
      contactName: "SentDm Pat",
      contactPhone: "+15551239999",
      inboundText: "1",
      ingestSource: "unit_test_sentdm_booking_wire",
    });

    assert.strictEqual(createCalls, 1);

    assert.strictEqual(phaseOut.smsBookingFlow.kind, "direct_outbound");

    const failedCreates = snapshotBookingRows().filter(
      (r) => r.action_type === "booking_create" && r.status === "failed"
    );
    const failRow = failedCreates[failedCreates.length - 1];
    assert.ok(failRow, "expected failed booking_actions row");

    const pay = failRow.raw_payload as {
      integration_request_summary?: Record<string, unknown>;
    };
    assert.ok(pay.integration_request_summary, "integration_request_summary should be persisted");
    const summary = pay.integration_request_summary!;
    assert.strictEqual(summary.memberNumberPresent, true);
    assert.strictEqual(summary.memberNumberFromContact, false);
    assert.strictEqual(typeof summary.dateTime, "string");
    assert.strictEqual(summary.dateTime, s.startTime);
    assert.strictEqual(summary.totalPlayerCount, 2);
    assert.strictEqual(summary.holes, "18");
    assert.strictEqual(summary.transportation, "cart");
    assert.strictEqual(summary.agenda_id_present, false);
    assert.strictEqual(summary.agenda_id, null);
    assert.ok(Object.prototype.hasOwnProperty.call(summary, "whoosh_raw_agenda_key_presence"));
    assert.ok(Object.prototype.hasOwnProperty.call(summary, "customer_phone_present"));
    } finally {
    process.env.WHOOSH_BOOKING_API_ENABLED = savedEnabled;
    process.env.WHOOSH_BOOKING_POST_PATH = savedPath;
    if (savedGuestMn === undefined) delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
    else process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = savedGuestMn;
    if (savedHoles === undefined) delete process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
    else process.env.WHOOSH_BOOKING_DEFAULT_HOLES = savedHoles;
    if (savedTransport === undefined) delete process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
    else process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = savedTransport;
    if (savedPaymentHoldRequired === undefined) delete process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS;
    else process.env.CLOSEOS_PAYMENT_REQUIRED_FOR_NON_MEMBERS = savedPaymentHoldRequired;
    }
  });

  test("Sent.dm inbound phase does not POST Whoosh booking when WHOOSH_BOOKING_GUEST_MEMBER_NUMBER is unset", async () => {
    const savedEnabled = process.env.WHOOSH_BOOKING_API_ENABLED;
    const savedPath = process.env.WHOOSH_BOOKING_POST_PATH;
    const savedGuestMn = process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;

    try {
      process.env.WHOOSH_BOOKING_API_ENABLED = "true";
      process.env.WHOOSH_BOOKING_POST_PATH = "/integration/api/booking_request_fixture";
      delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;

      let createCalls = 0;
      whooshBookingClient.createBooking = async (): Promise<WhooshBookingResult> => {
        createCalls += 1;
        return { ok: true, outcome: "confirmed", bookingId: "x", requestId: null, confirmationNumber: "y",
          startTime: "2035-06-15T02:30:00.000Z",
          endTime: "2035-06-15T03:30:00.000Z",
          raw: {},
        };
      };

      const s: NormalizedWhooshAvailabilitySlot = {
        startTime: "2035-06-15T02:30:00.000Z",
        endTime: "2035-06-15T03:30:00.000Z",
        bayOrResourceId: "whoosh-slot-sdm-mc",
        resourceName: "Bay M",
        serviceType: "simulator",
        priceEstimate: null,
        raw: {
          agenda_date: "2035-06-15",
          facility_slug: "simulators",
          course_id: "fc56dd17-ad78-4861-983b-bf7ec7d3233c",
          id: "slot-mc-sentdm",
        },
      };

      const offered_wire = [
        {
          option_index: 1,
          startTime: s.startTime,
          endTime: s.endTime,
          bayOrResourceId: s.bayOrResourceId,
          resourceName: s.resourceName,
          priceEstimate: null,
          serviceType: "simulator",
          raw: s.raw ?? {},
        },
      ];

      const preloadAvailability = {
        business_id: BID,
        conversation_id: CID,
        contact_id: PID,
        provider: "whoosh",
        action_type: "availability_lookup",
        status: "completed",
        service_type: "simulator",
        requested_date: "2035-06-15",
        party_size: 2,
        duration_minutes: 60,
        raw_payload: { agenda_date: "2035-06-15", offered_slots: offered_wire },
        created_at: new Date().toISOString(),
      };

      const seedMessage =
        "Book simulator bay 2035-06-15 evening for 2 players 60 minutes reservation booking reserve";
      const descRows = [
        {
          conversation_id: CID,
          direction: "inbound",
          channel: "sms",
          message_text: seedMessage,
          status: "received",
          created_at: "2035-06-09T03:00:05.000Z",
        },
      ];

      const audits: Record<string, unknown>[] = [];
      const { supabase } = createSentDmSupabaseBookingCapture({
        descRows,
        audits,
        bookingSeed: [preloadAvailability],
      });

      const phaseOut = await runInboundSmsBookingAugmentationPhase({
        supabase: supabase as never,
        conversationId: CID,
        businessId: BID,
        contactId: PID,
        contactPhone: "+15557654321",
        contactName: "No Guest Env",
        inboundText: "1",
        ingestSource: "unit_test_member_config_gate",
      });

      assert.strictEqual(createCalls, 0);
      assert.strictEqual(
        phaseOut.smsBookingFlow.kind === "direct_outbound" ?
          phaseOut.smsBookingFlow.debug.reason
        : "",
        "whoosh_booking_guest_member_unconfigured"
      );
    } finally {
      process.env.WHOOSH_BOOKING_API_ENABLED = savedEnabled;
      process.env.WHOOSH_BOOKING_POST_PATH = savedPath;
      if (savedGuestMn === undefined) delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
      else process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = savedGuestMn;
    }
  });
});
