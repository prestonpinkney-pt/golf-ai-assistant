import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveBusinessMessagingConfigFromDb } from "./business-messaging-config";

function mockSupabaseForPhoneLookupError(): SupabaseClient {
  return {
    from(table: string) {
      if (table !== "business_messaging_numbers") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: null,
            error: { message: "connection reset by peer" },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

test("phone routing DB errors fail closed instead of default-tenant fallback", async () => {
  await assert.rejects(
    () =>
      resolveBusinessMessagingConfigFromDb(mockSupabaseForPhoneLookupError(), {
        toNumber: "+15551234567",
      }),
    /business_messaging_numbers lookup failed: connection reset by peer/
  );
});
