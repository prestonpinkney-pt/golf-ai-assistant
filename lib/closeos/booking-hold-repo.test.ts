import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { NormalizedWhooshAvailabilitySlot } from "@/lib/whoosh/availability";

import {
  hasActiveSimulatorHoldConflict,
  holdRowBayMatchKeys,
  pickSlotCorrelationIds,
  slotIntervalsOverlapUtc,
} from "@/lib/closeos/booking-hold-repo";

const COURSE_ID = "fc56dd17-ad78-4861-983b-bf7ec7d3233c";

function sampleAdjacentBaySlots(): NormalizedWhooshAvailabilitySlot[] {
  const commonRaw = {
    agenda_date: "2035-06-17",
    facility_slug: "simulators",
    course_id: COURSE_ID,
  };
  return [
    {
      startTime: "2035-06-17T18:00:00.000Z",
      endTime: "2035-06-17T19:00:00.000Z",
      bayOrResourceId: "whoosh-slot-1100",
      resourceName: "Bay 1",
      serviceType: "simulator",
      priceEstimate: null,
      raw: { ...commonRaw, id: "473d2db9-f503-4dec-9afe-cdf8b029db8e" },
    },
    {
      startTime: "2035-06-17T18:15:00.000Z",
      endTime: "2035-06-17T19:15:00.000Z",
      bayOrResourceId: "whoosh-slot-1115",
      resourceName: "Bay 1",
      serviceType: "simulator",
      priceEstimate: null,
      raw: { ...commonRaw, id: "473d2db9-f503-4dec-9afe-cdf8b029db8d" },
    },
  ];
}

class FakeHoldSupabase {
  rows: Record<string, unknown>[] = [];

  from(table: string) {
    assert.equal(table, "closeos_bookings");
    const store = this;
    return {
      select(_cols?: string) {
        const filt: { pairs: Record<string, unknown>; ins: Record<string, string[]> } = {
          pairs: {},
          ins: {},
        };
        const builder = {
          eq(field: string, val: unknown) {
            filt.pairs[field] = val;
            return builder;
          },
          in(field: string, vals: string[]) {
            filt.ins[field] = vals;
            return Promise.resolve({ data: filterRows(store.rows), error: null });
          },
        };
        function filterRows(all: Record<string, unknown>[]) {
          return all.filter((r) => {
            const okPairs = Object.entries(filt.pairs).every(([k, v]) => r[k] === v);
            if (!okPairs) return false;
            for (const [kk, vv] of Object.entries(filt.ins)) {
              if (!vv.includes(String(r[kk] ?? ""))) return false;
            }
            return true;
          });
        }
        return builder;
      },
    };
  }
}

describe("pickSlotCorrelationIds", () => {
  test("prefers physical course_id over per-start occurrence bayOrResourceId", () => {
    const [slot1100, slot1115] = sampleAdjacentBaySlots();
    const a = pickSlotCorrelationIds(slot1100!);
    const b = pickSlotCorrelationIds(slot1115!);

    assert.equal(a.bayResourceId, COURSE_ID);
    assert.equal(b.bayResourceId, COURSE_ID);
    assert.ok(a.conflictBayIds.includes(COURSE_ID));
    assert.ok(a.conflictBayIds.includes("whoosh-slot-1100"));
    assert.ok(b.conflictBayIds.includes("whoosh-slot-1115"));
    assert.notEqual(a.slotIdExternal, b.slotIdExternal);
  });

  test("falls back to bayOrResourceId when course_id is absent", () => {
    const slot: NormalizedWhooshAvailabilitySlot = {
      startTime: "2035-06-17T18:00:00.000Z",
      endTime: "2035-06-17T19:00:00.000Z",
      bayOrResourceId: "vendor-slot-771",
      resourceName: "Bay A",
      serviceType: "simulator",
      priceEstimate: null,
      raw: { agenda_date: "2035-06-17", id: "vendor-slot-771" },
    };
    const ids = pickSlotCorrelationIds(slot);
    assert.equal(ids.bayResourceId, "vendor-slot-771");
    assert.deepEqual(ids.conflictBayIds, ["vendor-slot-771"]);
  });
});

describe("hasActiveSimulatorHoldConflict", () => {
  test("adjacent starts on same course_id collide even when hold bay_id is occurrence id", async () => {
    assert.equal(
      slotIntervalsOverlapUtc(
        "2035-06-17T18:00:00.000Z",
        "2035-06-17T19:00:00.000Z",
        "2035-06-17T18:15:00.000Z",
        "2035-06-17T19:15:00.000Z"
      ),
      true
    );

    const [slot1100, slot1115] = sampleAdjacentBaySlots();
    const holdSnap = {
      startTime: slot1100!.startTime,
      endTime: slot1100!.endTime,
      bayOrResourceId: slot1100!.bayOrResourceId,
      resourceName: slot1100!.resourceName,
      serviceType: slot1100!.serviceType,
      priceEstimate: null,
      raw: slot1100!.raw,
    };

    const sb = new FakeHoldSupabase();
    sb.rows.push({
      id: "hold-1",
      business_id: "biz-1",
      /** Legacy / occurrence-keyed bay_id (pre-fix). */
      bay_id: "whoosh-slot-1100",
      status: "held_pending_payment",
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      start_time: slot1100!.startTime,
      end_time: slot1100!.endTime,
      raw_payload: { slot_snapshot: holdSnap },
    });

    const corr = pickSlotCorrelationIds(slot1115!);
    const conflict = await hasActiveSimulatorHoldConflict(sb as never, {
      businessId: "biz-1",
      bayResourceId: corr.bayResourceId,
      conflictBayIds: corr.conflictBayIds,
      slotStartIso: slot1115!.startTime,
      slotEndIso: slot1115!.endTime,
    });
    assert.equal(conflict, true);
  });

  test("different course_id with overlapping times does not collide", async () => {
    const [slot1100] = sampleAdjacentBaySlots();
    const sb = new FakeHoldSupabase();
    sb.rows.push({
      id: "hold-other-bay",
      business_id: "biz-1",
      bay_id: "other-course-uuid",
      status: "held_pending_payment",
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      start_time: slot1100!.startTime,
      end_time: slot1100!.endTime,
      raw_payload: {
        slot_snapshot: {
          bayOrResourceId: "other-slot",
          raw: { course_id: "other-course-uuid", id: "other-slot" },
        },
      },
    });

    const corr = pickSlotCorrelationIds(slot1100!);
    const conflict = await hasActiveSimulatorHoldConflict(sb as never, {
      businessId: "biz-1",
      bayResourceId: corr.bayResourceId,
      conflictBayIds: corr.conflictBayIds,
      slotStartIso: slot1100!.startTime,
      slotEndIso: slot1100!.endTime,
    });
    assert.equal(conflict, false);
  });

  test("holdRowBayMatchKeys includes course_id from slot snapshot", () => {
    const keys = holdRowBayMatchKeys({
      bay_id: "whoosh-slot-1100",
      raw_payload: {
        slot_snapshot: {
          bayOrResourceId: "whoosh-slot-1100",
          raw: { course_id: COURSE_ID, id: "occ-1" },
        },
      },
    });
    assert.ok(keys.includes(COURSE_ID));
    assert.ok(keys.includes("whoosh-slot-1100"));
    assert.ok(keys.includes("occ-1"));
  });
});
