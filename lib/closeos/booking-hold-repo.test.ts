import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import { hasActiveSimulatorHoldConflict } from "@/lib/closeos/booking-hold-repo";

function fakeHoldConflictSb(rows: Record<string, unknown>[]): SupabaseClient {
  return {
    from(table: string) {
      assert.equal(table, "closeos_bookings");
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    in(_field: string, statuses: string[]) {
                      const filtered = rows.filter((r) =>
                        statuses.includes(String(r.status ?? ""))
                      );
                      return Promise.resolve({ data: filtered, error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

test("payment_needs_review overlapping paid row blocks a second hold", async () => {
  const businessId = randomUUID();
  const supabase = fakeHoldConflictSb([
    {
      id: randomUUID(),
      start_time: "2026-05-09T03:40:00.000Z",
      end_time: "2026-05-09T04:40:00.000Z",
      status: "payment_needs_review",
      expires_at: "2026-05-08T22:00:00.000Z",
    },
  ]);

  const blocked = await hasActiveSimulatorHoldConflict(supabase, {
    businessId,
    bayResourceId: "bay-22",
    slotStartIso: "2026-05-09T03:40:00.000Z",
    slotEndIso: "2026-05-09T04:40:00.000Z",
  });
  assert.equal(blocked, true);
});

test("non-overlapping payment_needs_review does not block", async () => {
  const businessId = randomUUID();
  const supabase = fakeHoldConflictSb([
    {
      id: randomUUID(),
      start_time: "2026-05-09T06:00:00.000Z",
      end_time: "2026-05-09T07:00:00.000Z",
      status: "payment_needs_review",
      expires_at: "2026-05-08T22:00:00.000Z",
    },
  ]);

  const blocked = await hasActiveSimulatorHoldConflict(supabase, {
    businessId,
    bayResourceId: "bay-22",
    slotStartIso: "2026-05-09T03:40:00.000Z",
    slotEndIso: "2026-05-09T04:40:00.000Z",
  });
  assert.equal(blocked, false);
});
