import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { hasActiveSimulatorHoldConflict } from "@/lib/closeos/booking-hold-repo";

describe("hasActiveSimulatorHoldConflict", () => {
  test("paid_whoosh_failed overlapping rows still block a new hold", async () => {
    const rows = [
      {
        id: "paid-failed-1",
        start_time: "2026-05-09T03:40:00.000Z",
        end_time: "2026-05-09T04:40:00.000Z",
        status: "paid_whoosh_failed",
        expires_at: "2026-05-09T06:00:00.000Z",
      },
    ];

    const supabase = {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  eq() {
                    return {
                      in: async () => ({ data: rows, error: null }),
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as SupabaseClient;

    const blocked = await hasActiveSimulatorHoldConflict(supabase, {
      businessId: "biz-1",
      bayResourceId: "bay-22",
      slotStartIso: "2026-05-09T03:50:00.000Z",
      slotEndIso: "2026-05-09T04:20:00.000Z",
    });
    assert.equal(blocked, true);
  });
});
