import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { beforeEach, describe } from "node:test";

import { BOOKING_CONFIRMATION_HANDOFF_REPLY } from "@/lib/ai/booking-outbound-guard";
import { processSquarePaymentCompletedForBookingHold } from "@/lib/closeos/process-square-booking-payment-hold";
import { sendMessage } from "@/lib/send-message";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhooshBookingCreateParams, WhooshBookingResult } from "@/lib/whoosh/bookings";

const FIXED_WEBHOOK_AT = () => new Date("2026-05-08T22:40:00.000Z");

const HOLD_EXPIRES_BEFORE_WEBHOOK = "2026-05-08T22:39:59.999Z";
const HOLD_EXPIRES_AFTER_WEBHOOK = "2026-05-09T06:39:59.999Z";

const CONTACT_PHONE_E164 = "+15551239999";

type CloseOsRow = Record<string, unknown>;

function baseSlotSnapshot(): Record<string, unknown> {
  return {
    startTime: "2026-05-09T03:40:00.000Z",
    endTime: "2026-05-09T04:40:00.000Z",
    bayOrResourceId: "bay-22",
    serviceType: "simulator",
    resourceName: "Bay 22",
    raw: { id: "slot-ext-1", agenda_id: "agenda-correl-9" },
  };
}

function makeHoldRow(opts: Partial<CloseOsRow> & { id: string; contact_id: string }): CloseOsRow {
  const amount_due_cents =
    typeof opts.amount_due_cents === "number" ? opts.amount_due_cents : 8400;
  const base = {
    id: opts.id,
    business_id: opts.business_id ?? randomUUID(),
    conversation_id: opts.conversation_id ?? null,
    contact_id: opts.contact_id,
    service_type: "simulator",
    start_time: opts.start_time ?? "2026-05-09T03:40:00.000Z",
    end_time: opts.end_time ?? "2026-05-09T04:40:00.000Z",
    bay_id: opts.bay_id ?? "bay-22",
    party_size: opts.party_size ?? 2,
    duration_minutes: opts.duration_minutes ?? 60,
    raw_payload: opts.raw_payload ?? {
      agenda_date: "2026-05-08",
      slot_snapshot: baseSlotSnapshot(),
    },
    amount_due_cents,
    currency: "USD",
    expires_at: opts.expires_at ?? HOLD_EXPIRES_AFTER_WEBHOOK,
    status: opts.status ?? "held_pending_payment",
    payment_status: opts.payment_status ?? "pending",
    payment_provider: "square",
  };
  return { ...base, ...opts, amount_due_cents, id: opts.id, contact_id: opts.contact_id };
}

function createBookingHoldFakeSb(input: {
  booking: CloseOsRow;
  contactPhone?: string | null;
}): { supabase: SupabaseClient; getBookingSnapshot: () => CloseOsRow } {
  const rowId = String(input.booking.id);
  const bookings = new Map<string, CloseOsRow>([[rowId, { ...input.booking }]]);
  const contactId = typeof input.booking.contact_id === "string" ? input.booking.contact_id : "";
  const phone = input.contactPhone ?? CONTACT_PHONE_E164;

  const supabase = {
    from(table: string) {
      return {
        select(_sel: string) {
          return {
            eq(field: string, val: unknown) {
              return {
                maybeSingle: async (): Promise<{ data: unknown; error: null }> => {
                  if (table === "contacts" && field === "id") {
                    const cid = typeof val === "string" ? val : "";
                    const data =
                      cid && cid === contactId ?
                        {
                          phone,
                          name: "Test Golfer",
                        }
                      : null;
                    return { data, error: null };
                  }

                  if (table === "closeos_bookings" && field === "id") {
                    const idStr = typeof val === "string" ? val : String(val ?? "");
                    const r = bookings.get(idStr);
                    return { data: r ? { ...r } : null, error: null };
                  }

                  return { data: null, error: null };
                },
              };
            },
          };
        },

        update(patch: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          const api = {
            eq(field: string, val: unknown) {
              filters[field] = val;
              return api;
            },
            select(_sel?: string) {
              return {
                maybeSingle: async () => {
                  if (table !== "closeos_bookings") {
                    return { data: null, error: null };
                  }
                  const idStr = typeof filters.id === "string" ? filters.id : "";
                  const cur = bookings.get(idStr);
                  if (!cur) return { data: null, error: null };
                  if (
                    typeof filters.status === "string" &&
                    String(cur.status) !== filters.status
                  ) {
                    return { data: null, error: null };
                  }
                  Object.assign(cur, patch);
                  return { data: { id: idStr }, error: null };
                },
              };
            },
            then(
              resolve: (v: { error: null }) => unknown,
              reject?: (e: unknown) => unknown
            ) {
              return Promise.resolve()
                .then(async () => {
                  if (table === "closeos_bookings") {
                    const idStr = typeof filters.id === "string" ? filters.id : "";
                    const cur = bookings.get(idStr);
                    if (cur) {
                      if (
                        typeof filters.status === "string" &&
                        String(cur.status) !== filters.status
                      ) {
                        return { error: null };
                      }
                      Object.assign(cur, patch);
                    }
                  }
                  return { error: null };
                })
                .then(resolve, reject);
            },
          };
          return api;
        },
      };
    },
  } as unknown as SupabaseClient;

  return {
    supabase,
    getBookingSnapshot: () => {
      const r = bookings.get(rowId)!;
      return { ...r };
    },
  };
}

beforeEach(() => {
  delete process.env.CLOSEOS_AUTONOMOUS_BOOKING_CONFIRM_ON_PAYMENT;
  delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
});

describe("processSquarePaymentCompletedForBookingHold", () => {
  test("paid before expiration + amount match confirms hold, timestamps + confirmation SMS + Whoosh", async () => {
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-unit";

    let whooshAttempts = 0;
    let whooshParams: WhooshBookingCreateParams | null = null;
    const sendCalls: Parameters<typeof sendMessage>[0][] = [];

    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId }),
    });

    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "unit-square-token",
      closeosBookingId: id,
      squarePaymentId: "sqpay_111",
      orderId: "order_aaa",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
        createWhooshBooking: async (p: WhooshBookingCreateParams): Promise<WhooshBookingResult> => {
          whooshAttempts++;
          whooshParams = p;
          return {
            ok: true,
            outcome: "confirmed",
            bookingId: "whoosh-b1",
            requestId: "req-whoosh-99",
            confirmationNumber: "cnf-77",
            startTime: p.selectedSlot.startTime,
            endTime: p.selectedSlot.endTime,
            raw: {},
          };
        },
      },
    });

    assert.equal(whooshAttempts, 1);
    assert.ok(whooshParams);
    assert.match(res.outcomeSummary, /^confirmed_after_square_/);
    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0].message.includes("Confirmed for"));

    const snap = getBookingSnapshot();
    assert.equal(snap.status, "paid_confirmed");
    assert.equal(snap.payment_status, "paid");
    assert.equal(typeof snap.paid_at, "string");
    assert.ok((snap.paid_at as string).length > 8);
    assert.equal(typeof snap.confirmed_at, "string");
    assert.equal(snap.whoosh_sync_needed, false);
    assert.equal((snap.raw_payload as Record<string, unknown>).provider_booking_id, "whoosh-b1");
  });

  test("Whoosh responds with agenda_not_found → paid_confirmed + whoosh_sync_needed + booked-style SMS still sent", async () => {
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-unit";

    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId }),
    });

    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "sqpay_agenda",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
        createWhooshBooking: async (): Promise<WhooshBookingResult> => ({
          ok: false,
          error: `Whoosh booking HTTP 422: agenda_not_found for slot abc`,
        }),
      },
    });

    assert.equal(res.outcomeSummary, "paid_confirmed_whoosh_sync_needed");
    const snap = getBookingSnapshot();
    assert.equal(snap.status, "paid_confirmed");
    assert.equal(snap.whoosh_sync_needed, true);
    assert.ok(typeof snap.last_error_summary === "string" && snap.last_error_summary!.includes("agenda_not_found"));
    assert.ok(sendCalls[0]?.message.includes("Confirmed for"));
  });

  test("payment after hold expiry routes to payment_needs_review (+ review metadata); no booked-style SMS", async () => {
    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({
        id,
        contact_id: contactId,
        expires_at: HOLD_EXPIRES_BEFORE_WEBHOOK,
      }),
    });

    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "sqpay_late",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
      },
    });

    assert.equal(res.outcomeSummary, "expired_hold_paid_need_review");
    const snap = getBookingSnapshot();
    assert.equal(snap.status, "payment_needs_review");
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.message.trim(), BOOKING_CONFIRMATION_HANDOFF_REPLY.trim());
    assert.ok(!(sendCalls[0]?.message ?? "").includes("Confirmed for"));

    const meta = snap.review_metadata as Record<string, unknown> | undefined;
    assert.ok(meta && meta.kind === "square_hold_expired_after_payment");
  });

  test("amount mismatch → payment_needs_review + mismatch review metadata + handoff SMS (not booked SMS)", async () => {
    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId, amount_due_cents: 8400 }),
    });

    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "sq_wrong",
      amountCents: 1234,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
      },
    });

    assert.equal(res.outcomeSummary, "amount_mismatch_needs_review");
    const snap = getBookingSnapshot();
    assert.equal(snap.status, "payment_needs_review");
    assert.equal(sendCalls.length, 1);
    assert.ok(!(sendCalls[0]?.message ?? "").includes("Confirmed for"));

    const meta = snap.review_metadata as Record<string, unknown>;
    assert.equal(meta.kind, "square_amount_mismatch");
    assert.equal(meta.expected_cents, 8400);
    assert.equal(meta.received_cents, 1234);
  });

  test("already confirmed is idempotent; does not add another confirmation SMS pass", async () => {
    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    let whooshAttempts = 0;
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId }),
    });

    const deps = {
      now: FIXED_WEBHOOK_AT,
      sendMessage: async (inp: Parameters<typeof sendMessage>[0]) => {
        sendCalls.push(inp);
        return { success: true, provider: "test", external_id: "x", status: "queued" };
      },
      createWhooshBooking: async (): Promise<WhooshBookingResult> => {
        whooshAttempts++;
        return {
          ok: true,
          outcome: "confirmed" as const,
          bookingId: "ok",
          requestId: null,
          confirmationNumber: "c99",
          startTime: "2026-05-09T03:40:00.000Z",
          endTime: "2026-05-09T04:40:00.000Z",
          raw: {},
        };
      },
    };

    await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "paid_once",
      amountCents: 8400,
      deps,
    });

    assert.equal(sendCalls.length, 1);

    const res2 = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "duplicate_webhook_retry",
      amountCents: 8400,
      deps,
    });

    assert.equal(res2.handled, true);
    assert.equal(res2.outcomeSummary, "already_confirmed_noop");
    assert.equal(whooshAttempts, 1);
    assert.equal(sendCalls.length, 1);
    assert.ok(getBookingSnapshot().status === "paid_confirmed");
  });

  test("hold_cancelled ignores paid webhook safely (no SMS churn)", async () => {
    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId, status: "hold_cancelled" }),
    });

    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "sq_ignore",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
      },
    });

    assert.equal(res.outcomeSummary, "ignored_cancelled_hold");
    assert.equal(sendCalls.length, 0);
    assert.equal(getBookingSnapshot().status, "hold_cancelled");
  });

  test("missing closeos_booking_id returns safe miss without crashing", async () => {
    const row = makeHoldRow({ id: randomUUID(), contact_id: randomUUID() });
    const { supabase } = createBookingHoldFakeSb({ booking: row });

    let threw = false;
    try {
      const miss = await processSquarePaymentCompletedForBookingHold({
        supabase,
        accessTokenSquare: "tok",
        closeosBookingId: null,
        squarePaymentId: "none",
        amountCents: 1,
      });
      assert.equal(miss.handled, false);
      assert.equal(miss.outcomeSummary, "missing_closeos_booking_id_guess");
    } catch {
      threw = true;
    }
    assert.equal(threw, false);
  });

  test("Whoosh booking fails post-payment → autonomous SMS confirmation + whoosh_sync_needed + persists error summary", async () => {
    process.env.CLOSEOS_AUTONOMOUS_BOOKING_CONFIRM_ON_PAYMENT = "true";
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-unit";

    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    let whooshAttempts = 0;

    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId }),
    });

    const fatalMsg = `Whoosh booking HTTP 500: temporary outage xyz`;
    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "paid_then_fail",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
        createWhooshBooking: async (): Promise<WhooshBookingResult> => {
          whooshAttempts++;
          return {
            ok: false,
            error: fatalMsg,
          };
        },
      },
    });

    assert.equal(whooshAttempts, 1);
    assert.equal(res.outcomeSummary, "paid_confirmed_autonomous_whoosh_retry");

    const snap = getBookingSnapshot();
    assert.equal(snap.status, "paid_confirmed");
    assert.equal(snap.payment_status, "paid");
    assert.equal(snap.whoosh_sync_needed, true);
    assert.equal(typeof snap.confirmed_at, "string");
    assert.equal(snap.last_error_summary, fatalMsg.slice(0, 500));

    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0]!.message.includes("Confirmed for"));
    assert.ok(!sendCalls[0]!.message.includes("trouble completing"));
  });

  test("paid hold + Whoosh 422 + autonomous true sends confirmation SMS", async () => {
    process.env.CLOSEOS_AUTONOMOUS_BOOKING_CONFIRM_ON_PAYMENT = "true";
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-unit";

    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId }),
    });

    const whoosh422 = "Whoosh booking HTTP 422: validation failed for booking_request";
    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "paid_then_422",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
        createWhooshBooking: async (): Promise<WhooshBookingResult> => ({
          ok: false,
          error: whoosh422,
        }),
      },
    });

    assert.equal(res.outcomeSummary, "paid_confirmed_autonomous_whoosh_retry");
    const snap = getBookingSnapshot();
    assert.equal(snap.status, "paid_confirmed");
    assert.equal(snap.payment_status, "paid");
    assert.equal(snap.whoosh_sync_needed, true);
    assert.equal(typeof snap.confirmed_at, "string");
    assert.equal(snap.last_error_summary, whoosh422);
    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0]!.message.includes("Confirmed for"));
    assert.ok(!sendCalls[0]!.message.includes("trouble completing"));
  });

  test("paid hold + Whoosh 422 + autonomous false sends trouble handoff", async () => {
    delete process.env.CLOSEOS_AUTONOMOUS_BOOKING_CONFIRM_ON_PAYMENT;
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-unit";

    const sendCalls: Parameters<typeof sendMessage>[0][] = [];
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId }),
    });

    const whoosh422 = "Whoosh booking HTTP 422: validation failed for booking_request";
    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "paid_then_422_no_auto",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
        createWhooshBooking: async (): Promise<WhooshBookingResult> => ({
          ok: false,
          error: whoosh422,
        }),
      },
    });

    assert.equal(res.outcomeSummary, "paid_whoosh_api_failed_handoff_sent");
    const snap = getBookingSnapshot();
    assert.equal(snap.status, "paid_whoosh_failed");
    assert.equal(snap.payment_status, "paid");
    assert.equal(snap.last_error_summary, whoosh422);
    assert.equal(sendCalls.length, 1);
    assert.ok(sendCalls[0]!.message.includes("trouble completing"));
    assert.ok(!sendCalls[0]!.message.includes("Confirmed for"));
  });

  test("generic Whoosh failure without autonomous SMS mode keeps trouble-handoff semantics", async () => {
    delete process.env.CLOSEOS_AUTONOMOUS_BOOKING_CONFIRM_ON_PAYMENT;
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-unit";

    const sendCalls: Parameters<typeof sendMessage>[0][] = [];

    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({ id, contact_id: contactId }),
    });

    const fatalMsg = "Whoosh booking HTTP 504: upstream timeout";

    await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "pay_fail_whoosh_soft",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        sendMessage: async (inp) => {
          sendCalls.push(inp);
          return { success: true, provider: "test", external_id: "x", status: "queued" };
        },
        createWhooshBooking: async (): Promise<WhooshBookingResult> => ({
          ok: false,
          error: fatalMsg,
        }),
      },
    });

    const snap = getBookingSnapshot();
    assert.equal(snap.status, "paid_whoosh_failed");
    assert.ok(!(sendCalls[0]?.message ?? "").includes("Confirmed for"));
    assert.ok((sendCalls[0]?.message ?? "").includes("trouble completing"));
    assert.equal(typeof snap.last_error_summary, "string");
  });

  test("paid_pending_whoosh webhook retry does not re-POST Whoosh", async () => {
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "guest-unit";
    let whooshAttempts = 0;
    const id = randomUUID();
    const contactId = randomUUID();
    const { supabase, getBookingSnapshot } = createBookingHoldFakeSb({
      booking: makeHoldRow({
        id,
        contact_id: contactId,
        status: "paid_pending_whoosh",
        payment_status: "paid",
      }),
    });

    const res = await processSquarePaymentCompletedForBookingHold({
      supabase,
      accessTokenSquare: "tok",
      closeosBookingId: id,
      squarePaymentId: "dup_while_pending_whoosh",
      amountCents: 8400,
      deps: {
        now: FIXED_WEBHOOK_AT,
        createWhooshBooking: async (): Promise<WhooshBookingResult> => {
          whooshAttempts += 1;
          return {
            ok: true,
            outcome: "confirmed",
            bookingId: "should-not-run",
            requestId: null,
            confirmationNumber: null,
            startTime: "2026-05-09T03:40:00.000Z",
            endTime: "2026-05-09T04:40:00.000Z",
            raw: {},
          };
        },
      },
    });

    assert.equal(res.outcomeSummary, "whoosh_finalize_in_progress_noop");
    assert.equal(whooshAttempts, 0);
    assert.equal(getBookingSnapshot().status, "paid_pending_whoosh");
  });
});
