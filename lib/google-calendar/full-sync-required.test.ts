import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isGoogleCalendarFullSyncRequired,
  syncWithFullSyncTokenRecovery,
} from "./full-sync-required";

describe("isGoogleCalendarFullSyncRequired", () => {
  test("detects gaxios-style 410 response.status", () => {
    assert.equal(
      isGoogleCalendarFullSyncRequired({
        response: { status: 410 },
        message: "Gone",
      }),
      true
    );
  });

  test("detects numeric code 410", () => {
    assert.equal(isGoogleCalendarFullSyncRequired({ code: 410 }), true);
  });

  test("detects string code 410", () => {
    assert.equal(isGoogleCalendarFullSyncRequired({ code: "410" }), true);
  });

  test("detects fullSyncRequired reason without status", () => {
    assert.equal(
      isGoogleCalendarFullSyncRequired({
        errors: [{ reason: "fullSyncRequired" }],
        message: "Sync token is no longer valid, a full sync is required.",
      }),
      true
    );
  });

  test("detects message text from Google Calendar API", () => {
    assert.equal(
      isGoogleCalendarFullSyncRequired({
        message: "Sync token is no longer valid, a full sync is required.",
      }),
      true
    );
  });

  test("ignores unrelated errors", () => {
    assert.equal(
      isGoogleCalendarFullSyncRequired({
        code: 403,
        message: "Request had insufficient authentication scopes.",
      }),
      false
    );
    assert.equal(isGoogleCalendarFullSyncRequired(null), false);
    assert.equal(isGoogleCalendarFullSyncRequired("boom"), false);
  });
});

describe("syncWithFullSyncTokenRecovery", () => {
  test("clears sync token and retries once on 410", async () => {
    const calls: Array<string | null> = [];
    let cleared = false;

    const result = await syncWithFullSyncTokenRecovery({
      calendar: { sync_token: "stale-token" },
      clearSyncToken: async () => {
        cleared = true;
      },
      sync: async (calendar) => {
        calls.push(calendar.sync_token);
        if (calendar.sync_token) {
          const error = Object.assign(new Error("Gone"), {
            code: 410,
            errors: [{ reason: "fullSyncRequired" }],
          });
          throw error;
        }
        return { syncedEvents: 2 };
      },
    });

    assert.equal(cleared, true);
    assert.deepEqual(calls, ["stale-token", null]);
    assert.deepEqual(result, { syncedEvents: 2 });
  });

  test("does not retry when calendar has no sync token", async () => {
    await assert.rejects(
      () =>
        syncWithFullSyncTokenRecovery({
          calendar: { sync_token: null },
          clearSyncToken: async () => {
            throw new Error("should not clear");
          },
          sync: async () => {
            throw Object.assign(new Error("Gone"), { code: 410 });
          },
        }),
      /Gone/
    );
  });

  test("does not clear token for non-410 failures", async () => {
    let cleared = false;

    await assert.rejects(
      () =>
        syncWithFullSyncTokenRecovery({
          calendar: { sync_token: "live-token" },
          clearSyncToken: async () => {
            cleared = true;
          },
          sync: async () => {
            throw Object.assign(new Error("rate limited"), { code: 429 });
          },
        }),
      /rate limited/
    );

    assert.equal(cleared, false);
  });
});
