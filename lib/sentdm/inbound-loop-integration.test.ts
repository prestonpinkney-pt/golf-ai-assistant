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
  // eslint-disable-next-line no-var
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

function envelopeWithText(base: Record<string, unknown>, text: string) {
  const clone = structuredClone(base) as Record<string, unknown>;
  const payload = clone.payload as Record<string, unknown> | undefined;
  if (payload) payload.text = text;
  return clone;
}

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
  });

  test("not interested sets cooling_off_until and skips auto-reply", async () => {
    const supabase = createInboundLoopMockSupabase();
    const base = fixtures.inbound_membership_question_envelope as Record<
      string,
      unknown
    >;
    const envelope = envelopeWithText(base, "Thanks, not interested");

    const result = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelope,
      externalId: "fixture-cooling-off-001",
      ingestSource: "sentdm_webhook",
    });

    assert.equal(result.ok, true);
    assert.equal(
      (result.body as { reason?: string }).reason,
      "cooling_off_started"
    );
    assert.equal(aiCalls(), 0);
    assert.equal(
      supabase.__countMessages((m) => m.direction === "outbound" && m.ai_generated === true),
      0
    );

    const contact = supabase.__tables.contacts.find((c) => c.phone === "+15551234567");
    assert.ok(contact?.cooling_off_until);
    assert.ok(
      supabase.__tables.audit_logs.some((a) => a.event_type === "cooling_off_started")
    );
  });

  test("STOP uses opt-out path, not cooling-off", async () => {
    const supabase = createInboundLoopMockSupabase();
    const base = fixtures.inbound_membership_question_envelope as Record<
      string,
      unknown
    >;
    const envelope = envelopeWithText(base, "STOP");

    const result = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelope,
      externalId: "fixture-stop-001",
      ingestSource: "sentdm_webhook",
    });

    assert.equal(result.ok, true);
    assert.equal((result.body as { control_reply?: string }).control_reply, "opt_out");
    assert.equal(aiCalls(), 0);

    const contact = supabase.__tables.contacts.find((c) => c.phone === "+15551234567");
    assert.equal(contact?.sms_opt_out, true);
    assert.equal(contact?.cooling_off_until, undefined);
  });

  test("STOP fails closed when contact opt-out update errors", async () => {
    const supabase = createInboundLoopMockSupabase();
    supabase.__failNextUpdate(
      "contacts",
      "simulated_opt_out_update_failure",
      (patch) => patch.sms_opt_out === true
    );
    const base = fixtures.inbound_membership_question_envelope as Record<
      string,
      unknown
    >;
    const envelope = envelopeWithText(base, "STOP");

    const result = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelope,
      externalId: "fixture-stop-fail-closed-001",
      ingestSource: "sentdm_webhook",
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.equal((result.body as { step?: string }).step, "stop_opt_out");
    assert.equal(aiCalls(), 0);

    const contact = supabase.__tables.contacts.find((c) => c.phone === "+15551234567");
    assert.equal(contact?.sms_opt_out, undefined);

    const inbound = supabase.__tables.inbound_events.find(
      (e) => e.external_id === "fixture-stop-fail-closed-001"
    );
    assert.equal(inbound?.status, "failed");
    assert.equal(inbound?.error_source, "stop_opt_out");

    assert.equal(
      supabase.__countMessages(
        (m) =>
          m.direction === "outbound" &&
          (m.intent === "stop" ||
            Boolean(
              (m.metadata as { compliance_stop_confirm?: boolean } | null)
                ?.compliance_stop_confirm
            ))
      ),
      0
    );
  });

  test("cooled-off contact does not receive auto-reply", async () => {
    const supabase = createInboundLoopMockSupabase();
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    supabase.__tables.contacts.push({
      id: "contact-already-cooled",
      phone: "+15551234567",
      cooling_off_until: future,
    });

    const envelope = fixtures.inbound_membership_question_envelope as Record<
      string,
      unknown
    >;

    const result = await runSentDmInboundConversationLoop({
      supabase,
      rawPayload: envelope,
      externalId: "fixture-cooled-active-001",
      ingestSource: "sentdm_webhook",
    });

    assert.equal(result.ok, true);
    assert.equal(
      (result.body as { reason?: string }).reason,
      "cooling_off_active"
    );
    assert.equal(aiCalls(), 0);
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
