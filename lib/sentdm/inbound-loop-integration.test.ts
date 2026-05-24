/**
 * Sent.dm webhook fixture → job processor → inbound-loop (mocked Supabase + OpenAI).
 * Run: npm run test:webhook
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, beforeEach, describe, test } from "node:test";

import { createInboundLoopMockSupabase } from "./test/inbound-loop-mock-supabase";

declare global {
  var __closeosGenerateAiDecisionCalls: number | undefined;
}

const fixtures = JSON.parse(
  readFileSync(join(process.cwd(), "scripts/sentdm-webhook-job-fixtures.json"), "utf8")
) as Record<string, Record<string, unknown>>;

type InboundLoopModule = typeof import("./inbound-loop");
type WebhookJobModule = typeof import("./process-webhook-job");

let runSentDmInboundConversationLoop: InboundLoopModule["runSentDmInboundConversationLoop"];
let runQueuedSentDmInboundJob: WebhookJobModule["runQueuedSentDmInboundJob"];

function aiCalls() {
  return globalThis.__closeosGenerateAiDecisionCalls ?? 0;
}

function resetAiCalls() {
  globalThis.__closeosGenerateAiDecisionCalls = 0;
}

before(async () => {
  const inboundLoop = await import("./inbound-loop");
  const webhookJob = await import("./process-webhook-job");
  runSentDmInboundConversationLoop = inboundLoop.runSentDmInboundConversationLoop;
  runQueuedSentDmInboundJob = webhookJob.runQueuedSentDmInboundJob;
});

describe("inbound-loop integration (mocked Supabase + AI)", () => {
  beforeEach(() => {
    resetAiCalls();
    process.env.CLOSEOS_QUIET_HOURS_ENABLED = "false";
    process.env.OPENAI_API_KEY = "test_openai_key_stub_unit";
  });

  test("happy path: inbound message row + AI reply decision", async () => {
    const supabase = createInboundLoopMockSupabase();
    const envelope = fixtures.inbound_membership_question_envelope as Record<
      string,
      unknown
    >;

    const result = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelope,
      externalId: "fixture-inbound-ext-001",
      ingestSource: "sentdm_webhook",
    });

    assert.equal(result.ok, true);
    assert.equal(aiCalls(), 1);
    assert.ok(
      supabase.__countMessages((m) => m.direction === "inbound") >= 1,
      "expected inbound message row"
    );
    assert.ok(
      supabase.__countMessages(
        (m) => m.direction === "outbound" && m.ai_generated === true
      ) >= 1,
      "expected AI outbound draft"
    );
    const inbound = supabase.__tables.messages.find(
      (m) =>
        m.direction === "inbound" && m.external_id === "fixture-inbound-ext-001"
    );
    assert.ok(inbound);
  });

  test("duplicate external_id dedupes on second processing", async () => {
    const supabase = createInboundLoopMockSupabase();
    const envelope = fixtures.inbound_membership_question_envelope as Record<
      string,
      unknown
    >;
    const ext = "fixture-dedupe-ext-009";

    const first = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelope,
      externalId: ext,
      ingestSource: "sentdm_webhook",
    });
    assert.equal(first.ok, true);

    const second = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelope,
      externalId: ext,
      ingestSource: "sentdm_webhook",
    });
    assert.equal(second.ok, true);
    assert.equal((second.body as { duplicate?: boolean }).duplicate, true);
    assert.equal(
      supabase.__countMessages((m) => m.direction === "inbound" && m.external_id === ext),
      1
    );
  });
});

describe("webhook job processor → inbound-loop", () => {
  beforeEach(() => {
    resetAiCalls();
    process.env.CLOSEOS_QUIET_HOURS_ENABLED = "false";
    process.env.OPENAI_API_KEY = "test_openai_key_stub_unit";
  });

  test("runQueuedSentDmInboundJob with text-only envelope (no live Sent.dm lookup)", async () => {
    const supabase = createInboundLoopMockSupabase();
    const jobId = "job-integration-001";
    supabase.__tables.webhook_jobs.push({
      id: jobId,
      status: "processing",
    });

    const payload = fixtures.inbound_membership_question_envelope as Record<
      string,
      unknown
    >;

    await runQueuedSentDmInboundJob(supabase, {
      id: jobId,
      payload,
      metadata: { ingest_source: "sentdm_webhook" },
    });

    assert.ok(supabase.__countMessages((m) => m.direction === "inbound") >= 1);
    assert.equal(aiCalls(), 1);
    const job = supabase.__tables.webhook_jobs.find((j) => j.id === jobId);
    assert.equal(job?.status, "completed");
  });
});
