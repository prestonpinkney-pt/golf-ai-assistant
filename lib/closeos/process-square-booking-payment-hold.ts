import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isLikelyE164Phone } from "@/lib/ai/phone-e164";
import {
  BOOKING_CONFIRMATION_HANDOFF_REPLY,
} from "@/lib/ai/booking-outbound-guard";
import {
  finalizeCloseOsBookingAfterWhooshConfirm,
  getCloseOsBookingById,
  type CloseOsBookingStatus,
} from "@/lib/closeos/booking-hold-repo";
import {
  smsAfterPaidWhooshConfirmed,
  smsAfterPaidWhooshFailed,
} from "@/lib/closeos/sms-hold-copy";
import { isCloseOsAutonomousBookingConfirmOnPayment } from "@/lib/closeos/booking-hold-config";
import type { NormalizedWhooshAvailabilitySlot } from "@/lib/whoosh/availability";
import type { WhooshBookingCreateParams, WhooshBookingResult } from "@/lib/whoosh/bookings";
import { createWhooshBooking } from "@/lib/whoosh/bookings";
import { sendMessage } from "@/lib/send-message";

const SQUARE_VERSION = "2025-01-23";

function apiBaseSquare(): string {
  return process.env.SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

async function fetchSquareJson<T>(
  path: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${apiBaseSquare()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`Square GET ${path} failed ${res.status}: ${text.slice(0, 800)}`);

  return (text ? JSON.parse(text) : {}) as T;
}

type SquareOrder = {
  id?: string;
  reference_id?: string;
  metadata?: Record<string, string | undefined>;
};

/** Fetch order metadata to resolve CloseOS booking id after Checkout payment completes. */
export async function fetchSquareOrderForPaymentMeta(input: {
  accessToken: string;
  orderId: string | null | undefined;
}): Promise<{ order: SquareOrder | null; closeosBookingId: string | null }> {
  if (!input.orderId?.trim()) return { order: null, closeosBookingId: null };

  try {
    const data = await fetchSquareJson<{ order?: SquareOrder }>(
      `/v2/orders/${encodeURIComponent(input.orderId.trim())}`,
      input.accessToken
    );

    const order = data.order ?? null;
    const meta = order?.metadata ?? {};

    const fromMeta =
      [
        meta.closeos_booking_id,
        meta.closeosBookingId,
        meta.CloseOS_Booking_Id,
      ].find((s) => typeof s === "string" && /^[a-f0-9-]{36}$/i.test(s.trim())) ?? null;

    const refTrim =
      order && typeof order.reference_id === "string" ? order.reference_id.trim() : "";
    const fromRef = refTrim.length >= 36 && /^[a-f0-9-]{36}$/i.test(refTrim) ? refTrim : null;

    return {
      order,
      closeosBookingId: (fromMeta && fromMeta.trim()) || fromRef || null,
    };
  } catch {
    return { order: null, closeosBookingId: null };
  }
}

function parseSlotSnapshot(row: Record<string, unknown>): NormalizedWhooshAvailabilitySlot | null {
  const rawPayload =
    row.raw_payload !== null &&
    typeof row.raw_payload === "object" &&
    !Array.isArray(row.raw_payload) ?
      (row.raw_payload as Record<string, unknown>)
    : {};
  const snap = rawPayload.slot_snapshot ?? rawPayload.offered_slot;
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) {
    const startTime = typeof row.start_time === "string" ? row.start_time : "";
    const endTime = typeof row.end_time === "string" ? row.end_time : "";
    const bayId = typeof row.bay_id === "string" ? row.bay_id.trim() : "";
    if (!startTime || !endTime || !bayId) return null;
    const st = typeof row.service_type === "string" ? row.service_type : "simulator";
    return {
      startTime,
      endTime,
      bayOrResourceId: bayId,
      resourceName: null,
      serviceType: st === "lesson" ? "lesson" : st === "event" ? "event" : "simulator",
      priceEstimate: null,
      raw: rowRawPayload(row),
    };
  }

  const s = snap as Record<string, unknown>;
  if (typeof s.startTime !== "string" || typeof s.endTime !== "string") return null;
  const bayRaw = typeof s.bayOrResourceId === "string" ? s.bayOrResourceId.trim() : "";
  if (!bayRaw) return null;
  const st = typeof s.serviceType === "string" ? s.serviceType : "simulator";
  const raw =
    s.raw !== null &&
    typeof s.raw === "object" &&
    !Array.isArray(s.raw) ?
      (s.raw as Record<string, unknown>)
    : {};

  return {
    startTime: s.startTime,
    endTime: s.endTime,
    bayOrResourceId: bayRaw,
    resourceName: typeof s.resourceName === "string" ? s.resourceName : null,
    serviceType: st === "lesson" ? "lesson" : st === "event" ? "event" : "simulator",
    priceEstimate:
      typeof s.priceEstimate === "string" ? s.priceEstimate : null,
    raw,
  };
}

function rowRawPayload(row: Record<string, unknown>): Record<string, unknown> {
  return row.raw_payload !== null &&
      typeof row.raw_payload === "object" &&
      !Array.isArray(row.raw_payload) ?
      (row.raw_payload as Record<string, unknown>)
    : {};
}

function mergeRawPayload(
  row: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...rowRawPayload(row),
    ...patch,
  };
}

async function loadContactOutboundContext(
  supabase: SupabaseClient,
  contactId: string | null
): Promise<{ phone: string | null; name: string | null }> {
  if (!contactId) return { phone: null, name: null };
  const { data } = await supabase.from("contacts").select("phone, name").eq("id", contactId).maybeSingle();

  const d = data as { phone?: unknown; name?: unknown } | null;
  const phoneRaw = typeof d?.phone === "string" ? d.phone.trim() : "";
  const phone = isLikelyE164Phone(phoneRaw) ? phoneRaw : null;
  const name = typeof d?.name === "string" ? d.name : null;

  return { phone, name };
}

async function sendOutboundSmsPreferringContact(
  supabase: SupabaseClient,
  contactId: string | null,
  message: string,
  sendFn: typeof sendMessage = sendMessage
): Promise<boolean> {
  const { phone, name } = await loadContactOutboundContext(supabase, contactId);
  if (!phone || !message.trim()) return false;
  try {
    await sendFn({
      channel: "sms",
      to: phone.trim(),
      message: message.trim(),
      name,
    });
    return true;
  } catch (e: unknown) {
    console.warn("[closeos-payment-hold] transactional SMS failure", String(e ?? ""));
    return false;
  }
}

function resolveProcessorNow(now?: Date | (() => Date)): Date {
  if (now === undefined) return new Date();
  return typeof now === "function" ? now() : now;
}

/** Stale-agenda faults are safe to reconcile later while treating payment as authoritative. */
function whooshErrorLooksLikeStaleAgendaRecoverableBooking(error: string): boolean {
  const e = error.toLowerCase();
  return (
    e.includes("agenda_not_found") ||
    /\bno matching agenda\b/.test(e) ||
    /\bunknown agenda\b/.test(e) ||
    e.includes("agenda has expired") ||
    e.includes("schedule no longer available")
  );
}

export type CloseOsSquareWebhookHoldProcessorDeps = {
  /** Deterministic instant for webhook processing (expires / paid_at timestamps). */
  now?: Date | (() => Date);
  createWhooshBooking?: (params: WhooshBookingCreateParams) => Promise<WhooshBookingResult>;
  sendMessage?: typeof sendMessage;
};

/**
 * Square Checkout webhook path — rejects expired unpaid holds (`payment_needs_review`), otherwise
 * executes Whoosh booking + transactional confirmation SMS once payment matches the hold expectations.
 */
export async function processSquarePaymentCompletedForBookingHold(opts: {
  supabase: SupabaseClient;
  accessTokenSquare: string;
  closeosBookingId: string | null;
  squarePaymentId: string;
  orderId?: string | null;
  amountCents: number;
  deps?: CloseOsSquareWebhookHoldProcessorDeps;
}): Promise<{ handled: boolean; outcomeSummary: string }> {
  const depNow = opts.deps?.now;
  const nowIso = () => resolveProcessorNow(depNow).toISOString();
  const sendSms = opts.deps?.sendMessage ?? sendMessage;
  const whooshCreate = opts.deps?.createWhooshBooking ?? createWhooshBooking;

  let closeosBookingId = opts.closeosBookingId?.trim() ?? null;
  const orderFetched =
    !closeosBookingId && opts.orderId ?
      await fetchSquareOrderForPaymentMeta({
        accessToken: opts.accessTokenSquare,
        orderId: opts.orderId,
      })
    : null;

  if (!closeosBookingId && orderFetched?.closeosBookingId) {
    closeosBookingId = orderFetched.closeosBookingId;
  }

  if (!closeosBookingId) return { handled: false, outcomeSummary: "missing_closeos_booking_id_guess" };

  const row = await getCloseOsBookingById(opts.supabase, closeosBookingId);
  if (!row) return { handled: false, outcomeSummary: "closeos_booking_row_missing" };

  const rowStatus = typeof row.status === "string" ? row.status : "";
  const paymentStatus = typeof row.payment_status === "string" ? row.payment_status : "";

  if (paymentStatus === "paid" && rowStatus === "paid_confirmed") {
    return { handled: true, outcomeSummary: "already_confirmed_noop" };
  }

  if (rowStatus === "hold_cancelled") {
    return { handled: true, outcomeSummary: "ignored_cancelled_hold" };
  }

  if (rowStatus !== "held_pending_payment" && rowStatus !== "paid_pending_whoosh") {
    return {
      handled: true,
      outcomeSummary: `ignored_non_hold_prior_status:${rowStatus}`,
    };
  }

  const expected = typeof row.amount_due_cents === "number" ? row.amount_due_cents : 0;

  /** Allow exact match only — prevents stray Square traffic from hijacking mismatched intents. */
  if (expected > 0 && opts.amountCents !== expected) {
    const nowBad = nowIso();
    await finalizeCloseOsBookingAfterWhooshConfirm(opts.supabase, closeosBookingId, {
      payment_status: "paid",
      status: "payment_needs_review" satisfies CloseOsBookingStatus,
      paid_at: nowBad,
      last_error_summary: `amount_mismatch webhook_cents=${opts.amountCents} expected=${expected}`,
      review_metadata: {
        kind: "square_amount_mismatch",
        expected_cents: expected,
        received_cents: opts.amountCents,
        webhook_at: nowBad,
      },
      raw_payload: mergeRawPayload(row, {
        square_order_id: opts.orderId ?? null,
        external_square_payment_id: opts.squarePaymentId,
      }),
      updated_at: nowBad,
    });
    await sendOutboundSmsPreferringContact(
      opts.supabase,
      typeof row.contact_id === "string" ? row.contact_id : null,
      BOOKING_CONFIRMATION_HANDOFF_REPLY,
      sendSms
    );

    return { handled: true, outcomeSummary: "amount_mismatch_needs_review" };
  }

  const curIso = nowIso();
  const exp = typeof row.expires_at === "string" ? row.expires_at : "";

  /** CloseOS hold clock — Stripe-style post-expiry webhook lands in manual review bucket. */
  if (exp && Date.parse(curIso) > Date.parse(exp)) {
    await finalizeCloseOsBookingAfterWhooshConfirm(opts.supabase, closeosBookingId, {
      payment_status: "paid",
      status: "payment_needs_review" satisfies CloseOsBookingStatus,
      paid_at: curIso,
      last_error_summary: `hold_expired webhook_after=${curIso} expires=${exp}`,
      review_metadata: {
        kind: "square_hold_expired_after_payment",
        hold_expires_at: exp,
        webhook_at: curIso,
      },
      raw_payload: mergeRawPayload(row, {
        square_order_id: opts.orderId ?? null,
        external_square_payment_id: opts.squarePaymentId,
      }),
      updated_at: curIso,
    });
    await sendOutboundSmsPreferringContact(
      opts.supabase,
      typeof row.contact_id === "string" ? row.contact_id : null,
      BOOKING_CONFIRMATION_HANDOFF_REPLY,
      sendSms
    );
    return { handled: true, outcomeSummary: "expired_hold_paid_need_review" };
  }

  await finalizeCloseOsBookingAfterWhooshConfirm(opts.supabase, closeosBookingId, {
    payment_status: "paid",
    paid_at: curIso,
    status: "paid_pending_whoosh" satisfies CloseOsBookingStatus,
    raw_payload: mergeRawPayload(row, {
      square_order_id: opts.orderId ?? null,
      external_square_payment_id: opts.squarePaymentId,
    }),
    updated_at: curIso,
  });

  const slot = parseSlotSnapshot(row);
  const ps = typeof row.party_size === "number" && row.party_size > 0 ? row.party_size : 1;

  const durationMinutes =
    typeof row.duration_minutes === "number" &&
    Number.isFinite(row.duration_minutes) &&
    row.duration_minutes >= 30 ?
      row.duration_minutes
    : 60;

  const contactId = typeof row.contact_id === "string" ? row.contact_id : null;

  if (!slot) {
    await finalizeCloseOsBookingAfterWhooshConfirm(opts.supabase, closeosBookingId, {
      payment_status: "paid",
      status: "payment_needs_review" satisfies CloseOsBookingStatus,
      last_error_summary: "slot_snapshot_missing_or_invalid_after_payment",
      updated_at: nowIso(),
    });
    await sendOutboundSmsPreferringContact(
      opts.supabase,
      contactId,
      BOOKING_CONFIRMATION_HANDOFF_REPLY,
      sendSms
    );
    return { handled: true, outcomeSummary: "paid_snapshot_review" };
  }

  const agendaRaw = rowRawPayload(row).agenda_date;
  const availAgenda =
    typeof agendaRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(agendaRaw) ?
      agendaRaw
    : null;

  const { phone, name } = await loadContactOutboundContext(opts.supabase, contactId);

  const bookingCreateParams: WhooshBookingCreateParams = {
    contactId: contactId ?? "square-hold-unknown-contact",
    customerName: name,
    customerPhone: phone,
    /** Payment-hold simulator guests replay into Whoosh POST using guest MN env parity. */
    contactMemberNumber: process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER?.trim() ?? null,
    selectedSlot: slot,
    partySize: Math.max(1, Math.round(ps)),
    durationMinutes,
    availabilityAgendaDate: availAgenda,
  };

  const result = await whooshCreate(bookingCreateParams);
  const nextUpdated = nowIso();

  if (!result.ok) {
    const errRaw =
      typeof result.error === "string" ?
        String(result.error).trim()
      : String(result.error);
    const errText = errRaw.slice(0, 500);
    const staleAgendaRecover = whooshErrorLooksLikeStaleAgendaRecoverableBooking(errRaw);
    const autonomous = isCloseOsAutonomousBookingConfirmOnPayment();

    if (staleAgendaRecover || autonomous) {
      await finalizeCloseOsBookingAfterWhooshConfirm(opts.supabase, closeosBookingId, {
        status: "paid_confirmed" satisfies CloseOsBookingStatus,
        payment_status: "paid",
        whoosh_sync_needed: true,
        confirmed_at: nextUpdated,
        last_error_summary: errText,
        raw_payload: mergeRawPayload(row, {
          square_order_id: opts.orderId ?? null,
          external_square_payment_id: opts.squarePaymentId,
          whoosh_error: errText,
        }),
        updated_at: nextUpdated,
      });
      await sendOutboundSmsPreferringContact(
        opts.supabase,
        contactId,
        smsAfterPaidWhooshConfirmed({
          slotStartIso: slot.startTime,
          partySize: bookingCreateParams.partySize,
          confirmationCode:
            staleAgendaRecover ? "Whoosh agenda sync pending" : "Paid — syncing bay with provider",
          bookingId: null,
        }),
        sendSms
      );
      return {
        handled: true,
        outcomeSummary:
          staleAgendaRecover ?
            "paid_confirmed_whoosh_sync_needed"
          : "paid_confirmed_autonomous_whoosh_retry",
      };
    }

    await finalizeCloseOsBookingAfterWhooshConfirm(opts.supabase, closeosBookingId, {
      status: "paid_whoosh_failed" satisfies CloseOsBookingStatus,
      last_error_summary: errText,
      payment_status: "paid",
      updated_at: nextUpdated,
    });
    await sendOutboundSmsPreferringContact(
      opts.supabase,
      contactId,
      smsAfterPaidWhooshFailed(),
      sendSms
    );
    return {
      handled: true,
      outcomeSummary: "paid_whoosh_api_failed_handoff_sent",
    };
  }

  await finalizeCloseOsBookingAfterWhooshConfirm(opts.supabase, closeosBookingId, {
    status: "paid_confirmed" satisfies CloseOsBookingStatus,
    payment_status: "paid",
    confirmed_at: nextUpdated,
    whoosh_sync_needed: false,
    raw_payload: mergeRawPayload(row, {
      square_order_id: opts.orderId ?? null,
      external_square_payment_id: opts.squarePaymentId,
      provider_booking_id: result.bookingId,
      provider_request_id: result.requestId,
      confirmation_hint:
        typeof result.confirmationNumber === "string" ? result.confirmationNumber :
        typeof result.bookingId === "string" ?
          result.bookingId
        : null,
    }),
    updated_at: nextUpdated,
  });

  await sendOutboundSmsPreferringContact(
    opts.supabase,
    contactId,
    smsAfterPaidWhooshConfirmed({
      slotStartIso: slot.startTime,
      partySize: bookingCreateParams.partySize,
      confirmationCode:
        result.confirmationNumber ?? result.bookingId ?? result.requestId,
      bookingId: result.bookingId,
    }),
    sendSms
  );

  return {
    handled: true,
    outcomeSummary: `confirmed_after_square_${result.outcome}`,
  };
}
