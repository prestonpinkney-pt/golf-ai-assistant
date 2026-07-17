import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { enqueueSentDmInboundWebhookJob } from "./webhook-queue";

function duplicateJobClient(status: "failed" | "completed") {
  const updates: Array<Record<string, unknown>> = [];

  const client = {
    from(table: string) {
      assert.equal(table, "webhook_jobs");
      return {
        insert() {
          return {
            select() {
              return {
                async maybeSingle() {
                  return {
                    data: null,
                    error: { code: "23505", message: "duplicate" },
                  };
                },
              };
            },
          };
        },
        select() {
          const query = {
            eq() {
              return query;
            },
            async maybeSingle() {
              return {
                data: { id: "job-1", status },
                error: null,
              };
            },
          };
          return query;
        },
        update(patch: Record<string, unknown>) {
          updates.push(patch);
          const query = {
            eq() {
              return query;
            },
            select() {
              return query;
            },
            async maybeSingle() {
              return {
                data: { id: "job-1" },
                error: null,
              };
            },
          };
          return query;
        },
      };
    },
  };

  return {
    supabase: client as unknown as SupabaseClient,
    updates,
  };
}

describe("enqueueSentDmInboundWebhookJob retries", () => {
  test("requeues a failed duplicate so provider retry can process it", async () => {
    const { supabase, updates } = duplicateJobClient("failed");

    const result = await enqueueSentDmInboundWebhookJob(supabase, {
      payload: { payload: { message_id: "message-1" } },
      eventType: "message.received",
      ingestSource: "sentdm_webhook",
    });

    assert.deepEqual(result, {
      ok: true,
      jobId: "job-1",
      duplicate: false,
    });
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, "pending");
    assert.equal(updates[0].last_error, null);
  });

  test("keeps a completed duplicate idempotent", async () => {
    const { supabase, updates } = duplicateJobClient("completed");

    const result = await enqueueSentDmInboundWebhookJob(supabase, {
      payload: { payload: { message_id: "message-1" } },
      eventType: "message.received",
      ingestSource: "sentdm_webhook",
    });

    assert.deepEqual(result, { ok: true, duplicate: true });
    assert.equal(updates.length, 0);
  });
});
