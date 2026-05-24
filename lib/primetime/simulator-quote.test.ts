/**
 * Regression tests for prepaid SMS bay quotes (primetime tiers → USD cents).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { estimateSimulatorBookingUsdCents } from "@/lib/primetime/simulator-quote";

describe("estimateSimulatorBookingUsdCents", () => {
  test("Sunday midday slot resolves peak weekend hourly solo cents", () => {
    /** 2035-06-17 is Monday in UTC noon but anchored slot is Sunday evening UTC → treat as anchored ISO weekday in LA. */
    const cents = estimateSimulatorBookingUsdCents({
      partySize: 1,
      durationMinutes: 60,
      slotStartIso: "2035-06-17T18:00:00.000Z",
    });
    assert.strictEqual(cents, 4000);
  });

  test("two players use group hourly grid", () => {
    const cents = estimateSimulatorBookingUsdCents({
      partySize: 2,
      durationMinutes: 60,
      slotStartIso: "2035-06-17T18:00:00.000Z",
    });
    assert.strictEqual(cents, 8000);
  });
});
