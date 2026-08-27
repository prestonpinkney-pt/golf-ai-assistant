/**
 * Whoosh SMS availability window parsing (clock vs coarse daypart).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DateTime } from "luxon";

import { parsePreferredTimeRange } from "@/lib/whoosh/availability";

function slotPassesParsedWindow(localHour: number, localMinute: number, range: string): boolean {
  const win = parsePreferredTimeRange(range);
  if (!win) return true;
  const dt = DateTime.fromObject(
    { year: 2035, month: 6, day: 7, hour: localHour, minute: localMinute },
    { zone: "America/Los_Angeles" }
  );
  const h = dt.hour + dt.minute / 60;
  return h >= win.hourStartInclusive && h < win.hourEndExclusive;
}

describe("parsePreferredTimeRange", () => {
  test("keeps coarse morning/afternoon/evening buckets", () => {
    assert.deepEqual(parsePreferredTimeRange("morning"), {
      hourStartInclusive: 11,
      hourEndExclusive: 14,
    });
    assert.deepEqual(parsePreferredTimeRange("afternoon"), {
      hourStartInclusive: 14,
      hourEndExclusive: 17,
    });
    assert.deepEqual(parsePreferredTimeRange("evening"), {
      hourStartInclusive: 17,
      hourEndExclusive: 21,
    });
    assert.deepEqual(parsePreferredTimeRange("tonight"), {
      hourStartInclusive: 17,
      hourEndExclusive: 21,
    });
  });

  test("explicit 7pm filters evening hour, not first public 11am slots", () => {
    const win = parsePreferredTimeRange("7pm");
    assert.deepEqual(win, { hourStartInclusive: 19, hourEndExclusive: 20 });
    assert.equal(slotPassesParsedWindow(19, 0, "7pm"), true);
    assert.equal(slotPassesParsedWindow(19, 15, "7pm"), true);
    assert.equal(slotPassesParsedWindow(19, 45, "7pm"), true);
    assert.equal(slotPassesParsedWindow(11, 0, "7pm"), false);
    assert.equal(slotPassesParsedWindow(11, 30, "7pm"), false);
    assert.equal(slotPassesParsedWindow(17, 0, "7pm"), false);
    assert.equal(slotPassesParsedWindow(20, 0, "7pm"), false);
  });

  test("parses spaced and colon clock phrases the SMS extractor emits", () => {
    assert.deepEqual(parsePreferredTimeRange("7 pm"), {
      hourStartInclusive: 19,
      hourEndExclusive: 20,
    });
    assert.deepEqual(parsePreferredTimeRange("7:30pm"), {
      hourStartInclusive: 19.5,
      hourEndExclusive: 20.5,
    });
    assert.deepEqual(parsePreferredTimeRange("11:00 AM"), {
      hourStartInclusive: 11,
      hourEndExclusive: 12,
    });
    assert.deepEqual(parsePreferredTimeRange("12pm"), {
      hourStartInclusive: 12,
      hourEndExclusive: 13,
    });
    assert.deepEqual(parsePreferredTimeRange("12am"), {
      hourStartInclusive: 0,
      hourEndExclusive: 1,
    });
    assert.equal(parsePreferredTimeRange("11am")?.hourStartInclusive, 11);
    assert.equal(slotPassesParsedWindow(11, 0, "11am"), true);
    assert.equal(slotPassesParsedWindow(12, 0, "11am"), false);
    assert.equal(parsePreferredTimeRange(null), null);
    assert.equal(parsePreferredTimeRange("not-a-window"), null);
  });
});
