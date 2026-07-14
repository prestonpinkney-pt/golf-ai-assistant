import assert from "node:assert/strict";
import test from "node:test";

import { slotToWindow } from "@/lib/whoosh/availability-windows";
import type { WhooshAggSlotRow } from "@/lib/whoosh/opportunities";

const rawSlot = {
  id: "bay-1-slot",
  course_name: "Simulator Bay 1",
  time: "2:00 PM",
  capacity: 1,
  used_capacity: 0,
  type: "simulator",
};

const normalizedSlot: WhooshAggSlotRow = {
  course_id: "bay-1",
  course_name: "Simulator Bay 1",
  time: "2:00 PM",
  capacity: 1,
  used_capacity: 0,
  type: "simulator",
};

test("availability cache excludes capacity outside public booking hours", () => {
  const mondayWindow = slotToWindow(
    rawSlot,
    normalizedSlot,
    "2026-05-25",
    "America/Los_Angeles",
    60
  );

  assert.equal(mondayWindow, null);
});

test("availability cache keeps open slots during public booking hours", () => {
  const wednesdayWindow = slotToWindow(
    rawSlot,
    normalizedSlot,
    "2026-05-27",
    "America/Los_Angeles",
    60
  );

  assert.ok(wednesdayWindow);
  assert.equal(wednesdayWindow.bookable, true);
});
