import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  computeCoolingOffUntil,
  COOLING_OFF_DAYS,
  getContactSendBlockedReason,
  isContactInCoolingOff,
  isUninterestedMessage,
} from "./cooling-off";

describe("cooling-off helpers", () => {
  test("not interested matches uninterested phrases", () => {
    assert.equal(isUninterestedMessage("Thanks but not interested right now"), true);
    assert.equal(isUninterestedMessage("maybe later"), true);
    assert.equal(isUninterestedMessage("I'm good."), true);
    assert.equal(isUninterestedMessage("Thanks, I'm good"), true);
    assert.equal(isUninterestedMessage("No thanks I'm good"), true);
    assert.equal(isUninterestedMessage("just looking"), true);
    assert.equal(isUninterestedMessage("not right now"), true);
  });

  test("booking affirmatives are not treated as uninterested cooling-off", () => {
    // Substring false positives that previously set cooling_off_until for 14 days
    // and silently suppressed AI/booking replies on the inbound loop.
    assert.equal(isUninterestedMessage("I'm good with Saturday"), false);
    assert.equal(isUninterestedMessage("im good for 4 players"), false);
    assert.equal(isUninterestedMessage("just looking for lesson times"), false);
    assert.equal(isUninterestedMessage("maybe later this week works"), false);
    assert.equal(isUninterestedMessage("I'm good anytime after 3"), false);
  });

  test("stop is not treated as uninterested cooling-off language", () => {
    assert.equal(isUninterestedMessage("STOP"), false);
    assert.equal(isUninterestedMessage("stop all"), false);
  });

  test("computeCoolingOffUntil adds default days", () => {
    const from = new Date("2026-05-24T12:00:00.000Z");
    const until = computeCoolingOffUntil(from);
    assert.equal(
      until.getTime() - from.getTime(),
      COOLING_OFF_DAYS * 86_400_000
    );
  });

  test("isContactInCoolingOff respects future timestamp", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.equal(isContactInCoolingOff({ cooling_off_until: future }), true);
    const past = new Date(Date.now() - 86_400_000).toISOString();
    assert.equal(isContactInCoolingOff({ cooling_off_until: past }), false);
  });

  test("getContactSendBlockedReason blocks opt-out before cooling-off", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.match(
      getContactSendBlockedReason({ sms_opt_out: true, cooling_off_until: future }) ?? "",
      /opted out/i
    );
  });

  test("getContactSendBlockedReason blocks manual send during cooling-off", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.match(
      getContactSendBlockedReason({ cooling_off_until: future }) ?? "",
      /cooling-off/i
    );
  });
});
