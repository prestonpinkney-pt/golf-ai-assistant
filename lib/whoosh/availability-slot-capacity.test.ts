import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isRawSlotExplicitlyUnavailable,
  normalizeRawIntegrationSlot,
  remainingCapacity,
} from "@/lib/whoosh/availability";

describe("Whoosh slot capacity / unavailability", () => {
  test("remainingCapacity keeps capacity 0 closed instead of inflating to 1", () => {
    assert.equal(remainingCapacity({ capacity: 0, used_capacity: 0, time: "10:00", course_id: null, course_name: null }), 0);
    assert.equal(remainingCapacity({ capacity: 4, used_capacity: 4, time: "10:00", course_id: null, course_name: null }), 0);
    assert.equal(remainingCapacity({ capacity: 4, used_capacity: 1, time: "10:00", course_id: null, course_name: null }), 3);
  });

  test("remainingCapacity defaults missing capacity to one open seat", () => {
    assert.equal(
      remainingCapacity({
        capacity: null,
        used_capacity: null,
        time: "10:00",
        course_id: null,
        course_name: null,
      }),
      1
    );
    assert.equal(
      remainingCapacity({
        capacity: null,
        used_capacity: 1,
        time: "10:00",
        course_id: null,
        course_name: null,
      }),
      0
    );
  });

  test("isRawSlotExplicitlyUnavailable honors Whoosh closed markers", () => {
    assert.equal(isRawSlotExplicitlyUnavailable({ available: false }), true);
    assert.equal(isRawSlotExplicitlyUnavailable({ is_available: false }), true);
    assert.equal(isRawSlotExplicitlyUnavailable({ remaining_spots: 0 }), true);
    assert.equal(isRawSlotExplicitlyUnavailable({ status: "booked" }), true);
    assert.equal(isRawSlotExplicitlyUnavailable({ available: true, remaining_spots: 2 }), false);
  });

  test("normalizeRawIntegrationSlot derives used capacity from remaining_spots", () => {
    const normalized = normalizeRawIntegrationSlot({
      time: "2:00 PM",
      capacity: 4,
      remaining_spots: 1,
      course_name: "Simulator 1",
    });
    assert.ok(normalized);
    assert.equal(normalized.capacity, 4);
    assert.equal(normalized.used_capacity, 3);
    assert.equal(remainingCapacity(normalized), 1);
  });

  test("normalizeRawIntegrationSlot forces closed inventory when available=false", () => {
    const normalized = normalizeRawIntegrationSlot({
      time: "3:00 PM",
      available: false,
      course_name: "Simulator 2",
    });
    assert.ok(normalized);
    assert.equal(normalized.capacity, 0);
    assert.equal(normalized.used_capacity, 0);
    assert.equal(remainingCapacity(normalized), 0);
  });

  test("normalizeRawIntegrationSlot uses max_capacity when capacity is absent", () => {
    const normalized = normalizeRawIntegrationSlot({
      time: "4:00 PM",
      max_capacity: 2,
      used_capacity: 0,
    });
    assert.ok(normalized);
    assert.equal(normalized.capacity, 2);
    assert.equal(remainingCapacity(normalized), 2);
  });
});
