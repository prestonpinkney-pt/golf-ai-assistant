import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isUnusableCancelledEventTime,
  resolveCancelledReservationWrite,
} from "./cancelled-event-sync";

describe("isUnusableCancelledEventTime", () => {
  test("treats missing and invalid values as unusable", () => {
    assert.equal(isUnusableCancelledEventTime(null), true);
    assert.equal(isUnusableCancelledEventTime(""), true);
    assert.equal(isUnusableCancelledEventTime("not-a-date"), true);
  });

  test("treats Google year-2000 placeholder times as unusable", () => {
    assert.equal(
      isUnusableCancelledEventTime("2000-01-01T02:00:00+02:00"),
      true
    );
  });

  test("accepts real modern event times", () => {
    assert.equal(
      isUnusableCancelledEventTime("2026-08-08T16:00:00-07:00"),
      false
    );
  });
});

describe("resolveCancelledReservationWrite", () => {
  test("skips when external id is missing", () => {
    assert.deepEqual(
      resolveCancelledReservationWrite({
        externalId: "  ",
        startsAt: "2026-08-08T16:00:00-07:00",
        endsAt: "2026-08-08T17:00:00-07:00",
        hasExistingReservation: false,
      }),
      { kind: "skip", reason: "missing_external_id" }
    );
  });

  test("status-only updates existing rows even when start/end are missing", () => {
    assert.deepEqual(
      resolveCancelledReservationWrite({
        externalId: "evt-1",
        startsAt: null,
        endsAt: null,
        hasExistingReservation: true,
      }),
      { kind: "status_only", externalId: "evt-1" }
    );
  });

  test("status-only updates existing rows even when Google sends placeholder times", () => {
    assert.deepEqual(
      resolveCancelledReservationWrite({
        externalId: "evt-1",
        startsAt: "2000-01-01T02:00:00+02:00",
        endsAt: "2000-01-02T02:00:00+02:00",
        hasExistingReservation: true,
      }),
      { kind: "status_only", externalId: "evt-1" }
    );
  });

  test("skips unknown cancelled events that have no usable times", () => {
    assert.deepEqual(
      resolveCancelledReservationWrite({
        externalId: "evt-new",
        startsAt: null,
        endsAt: null,
        hasExistingReservation: false,
      }),
      { kind: "skip", reason: "no_existing_and_no_usable_times" }
    );
  });

  test("full upserts never-synced cancelled events that still carry real times", () => {
    assert.deepEqual(
      resolveCancelledReservationWrite({
        externalId: "evt-new",
        startsAt: "2026-08-08T16:00:00-07:00",
        endsAt: "2026-08-08T17:00:00-07:00",
        hasExistingReservation: false,
      }),
      {
        kind: "full_upsert",
        externalId: "evt-new",
        startsAt: "2026-08-08T16:00:00-07:00",
        endsAt: "2026-08-08T17:00:00-07:00",
      }
    );
  });
});
