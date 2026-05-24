import { DateTime } from "luxon";

import {
  WHOOSH_BOOKING_TROUBLE_HANDOFF_REPLY,
} from "@/lib/ai/booking-outbound-guard";
import type { NormalizedWhooshAvailabilitySlot } from "@/lib/whoosh/availability";

const PAY_HOLD_TITLE = "Primetime Golf Bay Booking";

/** Customer SMS after slot pick — pays before Whoosh confirms. */
export function buildCloseOsSimulatorPaymentHoldOutboundSms(opts: {
  slotStartIso: string;
  durationMinutes: number;
  partySize: number;
  paymentLinkUrl: string;
  holdMinutes: number;
  resourceLabel: string | null;
  agendaDateIso: string | null;
}): string {
  const startShow = DateTime.fromISO(opts.slotStartIso, { zone: "utc" }).setZone("America/Los_Angeles");
  const datePhrase =
    startShow.isValid ? startShow.toFormat("cccc, LLL d") : opts.agendaDateIso ?? "that day";
  const timePhrase =
    startShow.isValid ? startShow.toFormat("h:mm a") : "that time";
  const durationMinutes = Math.max(1, Math.round(opts.durationMinutes));
  const endShow = startShow.isValid ? startShow.plus({ minutes: durationMinutes }) : null;
  const endPhrase = endShow?.isValid ? `-${endShow.toFormat("h:mm a")}` : "";
  const durationPhrase =
    durationMinutes % 60 === 0 ?
      `${durationMinutes / 60} hour${durationMinutes === 60 ? "" : "s"}`
    : `${durationMinutes} minutes`;

  const bay = opts.resourceLabel?.trim().split(/\s+/).slice(0, 6).join(" ") ?? "your bay";

  return (
    `Perfect — I can hold ${datePhrase} at ${timePhrase}${endPhrase} for ${durationPhrase} for ${opts.partySize} players. ` +
    `Complete payment here to confirm ${bay}: ${opts.paymentLinkUrl}. ` +
    `This hold expires in ${opts.holdMinutes} minutes.`
  );
}

export function buildPaymentHoldSquareDescriptionNote(slot: NormalizedWhooshAvailabilitySlot): string {
  const startShow = DateTime.fromISO(slot.startTime, { zone: "utc" }).setZone("America/Los_Angeles");
  const datePhrase = startShow.isValid ? startShow.toFormat("ccc LLL d") : "date TBD";
  const timePhrase = startShow.isValid ? startShow.toFormat("h:mm a") : "time TBD";
  const bay = slot.resourceName?.trim().slice(0, 160) ?? "Bay";
  return `${datePhrase} ${timePhrase} ${bay}`;
}

export { PAY_HOLD_TITLE };

export function smsAfterPaidWhooshConfirmed(opts: {
  slotStartIso: string;
  partySize: number;
  confirmationCode: string | null;
  bookingId: string | null;
}): string {
  const startShow = DateTime.fromISO(opts.slotStartIso, { zone: "utc" }).setZone("America/Los_Angeles");
  const dt = startShow.isValid ?
    `${startShow.toFormat("cccc, LLL d")} ${startShow.toFormat("h:mm a")}`
  : "your selected time";

  const ref = opts.confirmationCode ?? opts.bookingId ?? "";
  const refPhrase = ref ? ` Reference: ${ref}.` : "";
  /** Payment recorded + Whoosh accepted — acceptable to confirm phrasing post-payment. */
  return `Confirmed for ${dt} for ${opts.partySize} players.${refPhrase} Thanks for playing Primetime Golf!`;
}

export function smsAfterPaidWhooshFailed(): string {
  return WHOOSH_BOOKING_TROUBLE_HANDOFF_REPLY;
}
