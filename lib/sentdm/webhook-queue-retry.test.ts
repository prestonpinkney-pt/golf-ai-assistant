import assert from "node:assert/strict";
import { test } from "node:test";

import { enqueueSentDmInboundWebhookJob } from "./webhook-queue";

type QueryResult = {
  data?: Record<string, unknown> | null;
  error?: { code?: string; message: string } | null;
};

function createSupabaseMock(input: {
  insertResult: QueryResult;
  updateResult: QueryResult;
}) {
  const calls: Array<Record<string, unknown>> = [];

  return {
    calls,
    supabase: {
      from(table: string) {
        return {
          insert(row: Record<string, unknown>) {
            calls.push({ type: "insert", table, row });
            return {
              select(columns: string) {
                calls.push({ type: "insert_select", table, columns });
                return {
                  async maybeSingle() {
                    return input.insertResult;
                  },
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            calls.push({ type: "update", table, patch });
            const chain = {
              eq(column: string, value: unknown) {
                calls.push({ type: "update_eq", table, column, value });
                return chain;
              },
              select(columns: string) {
                calls.push({ type: "update_select", table, columns });
                return chain;
              },
              async maybeSingle() {
                return input.updateResult;
              },
            };
            return chain;
          },
        };
      },
    },
  };
}

test("failed duplicate webhook job is requeued instead of ignored", async () => {
  const { calls, supabase } = createSupabaseMock({
    insertResult: {
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    },
    updateResult: { data: { id: "job-existing-failed" }, error: null },
  });

  const result = await enqueueSentDmInboundWebhookJob(supabase as never, {
    payload: { message_id: "msg-123", text: "Can I book a bay?" },
    eventType: "message.received",
    ingestSource: "sentdm_webhook",
  });

  assert.deepEqual(result, {
    ok: true,
    jobId: "job-existing-failed",
    duplicate: false,
    requeued: true,
  });

  const update = calls.find((call) => call.type === "update");
  assert.equal(update?.table, "webhook_jobs");
  assert.equal((update?.patch as Record<string, unknown>).status, "pending");
  assert.equal((update?.patch as Record<string, unknown>).last_error, null);
  assert.equal((update?.patch as Record<string, unknown>).processed_at, null);

  const eqs = calls
    .filter((call) => call.type === "update_eq")
    .map((call) => [call.column, call.value]);
  assert.deepEqual(eqs, [
    ["provider", "sentdm"],
    ["external_id", "sentdm:msg-123"],
    ["status", "failed"],
  ]);
});

test("completed duplicate webhook job remains ignored", async () => {
  const { supabase } = createSupabaseMock({
    insertResult: {
      data: null,
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    },
    updateResult: { data: null, error: null },
  });

  const result = await enqueueSentDmInboundWebhookJob(supabase as never, {
    payload: { message_id: "msg-123", text: "Can I book a bay?" },
    eventType: "message.received",
    ingestSource: "sentdm_webhook",
  });

  assert.deepEqual(result, { ok: true, duplicate: true });
});
