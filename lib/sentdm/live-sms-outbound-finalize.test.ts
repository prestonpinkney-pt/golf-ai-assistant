/**
 * Sent.dm parity: disclose + confirmation guard strip fake booking celebrates.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BOOKING_CONFIRMATION_HANDOFF_REPLY } from "@/lib/ai/booking-outbound-guard";

import { finalizeLiveSmsOutboundText } from "./live-sms-outbound-finalize";

describe("live-sms-outbound-finalize", () => {
  test("SMS blocks Ive got you booked unless Whoosh confirms", () => {
    const hostile = `Great news! I've got you booked for 2 players at 6 PM this Sunday`;
    const out = finalizeLiveSmsOutboundText({
      draftReply: hostile,
      channel: "sms",
      businessName: "Primetime Golf",
      assistantName: "Sam",
      shouldDiscloseAutomation: false,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(out.confirmationGuardBlocked, true);
    assert.strictEqual(out.responseText.trim(), BOOKING_CONFIRMATION_HANDOFF_REPLY);

    const allowed = finalizeLiveSmsOutboundText({
      draftReply: hostile,
      channel: "sms",
      businessName: "Primetime Golf",
      assistantName: "Sam",
      shouldDiscloseAutomation: false,
      bookingConfirmedByWhoosh: true,
    });
    assert.strictEqual(allowed.confirmationGuardBlocked, false);
    assert.ok(/got\s+you\s+booked/i.test(allowed.responseText));
  });

  test("RCS passes through guard path unchanged", () => {
    const t = finalizeLiveSmsOutboundText({
      draftReply: "Booked!",
      channel: "rcs",
      businessName: "Primetime Golf",
      assistantName: "Sam",
      shouldDiscloseAutomation: false,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(t.responseText, "Booked!");
  });
});
