/**
 * Final SMS gate: blocks fake booking confirmations without Whoosh success metadata.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyBookingConfirmationOutboundGuard,
  BOOKING_CONFIRMATION_HANDOFF_REPLY,
  outboundImpliesBookingConfirmation,
} from "./booking-outbound-guard";

describe("booking-outbound-guard", () => {
  test("blocks celebratory booking language when Whoosh success flag is false", () => {
    const dangerous = "Your solo practice bay is booked for this Saturday at 6 PM.";
    assert.strictEqual(outboundImpliesBookingConfirmation(dangerous), true);

    const guarded = applyBookingConfirmationOutboundGuard({
      replyTextFull: dangerous,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(guarded.blocked, true);
    assert.strictEqual(guarded.replyTextFull, BOOKING_CONFIRMATION_HANDOFF_REPLY);
    assert.strictEqual(typeof guarded.matchedPattern, "string");
    assert.ok(guarded.matchedPattern!.length > 0);
  });

  test("allows confirmations when Gateway marks booking_confirmed_by_whoosh=true", () => {
    const copy = "Confirmed for Sat Jun 14 7:40 PM Downtown Oakland.";
    assert.strictEqual(outboundImpliesBookingConfirmation(copy), true);

    const guarded = applyBookingConfirmationOutboundGuard({
      replyTextFull: copy,
      bookingConfirmedByWhoosh: true,
    });
    assert.strictEqual(guarded.blocked, false);
    assert.strictEqual(guarded.replyTextFull, copy);
    assert.strictEqual(guarded.matchedPattern, undefined);
  });

  test("neutral availability copy passes without the flag", () => {
    const safe = "Sat Jun 14: I see 6:00 PM and 7:30 PM available. Reply 1, 2, or 3.";
    assert.strictEqual(outboundImpliesBookingConfirmation(safe), false);
    const guarded = applyBookingConfirmationOutboundGuard({
      replyTextFull: safe,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(guarded.blocked, false);
    assert.strictEqual(guarded.matchedPattern, undefined);
  });

  test("live block Got it your booking locked in priced", () => {
    const t =
      "Got it! Your booking for 2 players at 6 PM this Sunday is locked in for $80.";
    const g = applyBookingConfirmationOutboundGuard({
      replyTextFull: t,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(g.blocked, true);
    assert.strictEqual(g.replyTextFull, BOOKING_CONFIRMATION_HANDOFF_REPLY);
    assert.ok(g.matchedPattern);
  });

  test("live block Ill finalize curly apostrophe", () => {
    const t = `Great! I\u2019ll finalize your booking for 2 players at 6 PM this Sunday for $80.`;
    const g = applyBookingConfirmationOutboundGuard({
      replyTextFull: t,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(g.blocked, true);
    assert.strictEqual(g.replyTextFull, BOOKING_CONFIRMATION_HANDOFF_REPLY);
    assert.strictEqual(g.matchedPattern, "phrase_ll_finalize");
  });

  test("live block lock it in for you", () => {
    const t = `Sounds good, I'll lock it in for you.`;
    const g = applyBookingConfirmationOutboundGuard({
      replyTextFull: t,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(g.blocked, true);
    assert.strictEqual(g.matchedPattern, "phrase_lock_it_in");
  });

  test("looking forward plus booking cues blocks without Whoosh", () => {
    const t =
      "Perfect — bay time Sunday at 6 for 2 players. Looking forward to seeing you then!";
    const g = applyBookingConfirmationOutboundGuard({
      replyTextFull: t,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(g.blocked, true);
    assert.strictEqual(g.replyTextFull, BOOKING_CONFIRMATION_HANDOFF_REPLY);
    assert.strictEqual(g.matchedPattern, "looking_forward_then_booking_context");
  });

  test("looking forward alone without booking substance passes", () => {
    const t = "Thanks! Looking forward to seeing you then!";
    assert.strictEqual(outboundImpliesBookingConfirmation(t), false);
    const g = applyBookingConfirmationOutboundGuard({
      replyTextFull: t,
      bookingConfirmedByWhoosh: false,
    });
    assert.strictEqual(g.blocked, false);
  });

  test("Ive got you booked trips guard patterns", () => {
    assert.strictEqual(
      outboundImpliesBookingConfirmation("Great news! I've got you booked for Sunday."),
      true
    );
  });
});
