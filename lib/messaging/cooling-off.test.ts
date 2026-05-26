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
