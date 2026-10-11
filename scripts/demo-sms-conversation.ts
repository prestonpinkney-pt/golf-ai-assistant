/**
 * Replay a multi-turn SMS thread locally (no Sent.dm, no real send).
 * Exercises booking-flow copy + optional OpenAI for general/membership turns.
 *
 * Usage:
 *   npm run demo:sms-conversation
 *   npm run demo:sms-conversation -- --scenario lesson
 *   npm run demo:sms-conversation -- --scenario membership   # needs OPENAI_API_KEY
 */
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DateTime, Settings } from "luxon";

import type { ConversationHistoryMessage } from "@/lib/ai/conversation-reply-core";
import { decidePlaybook, generateAiDecision } from "@/lib/ai/conversation-reply-core";
import { buildDefaultAiSourceOfTruth } from "@/app/api/config/ai-source-of-truth";
import type { BookingFlowAugmentation } from "@/lib/ai/sms-booking-flow";
import {
  runCloseOsSmsBookingAugmentation,
  whooshAvailabilityClient,
} from "@/lib/ai/sms-booking-flow";
import type { NormalizedWhooshAvailabilitySlot } from "@/lib/whoosh/availability";
const require = createRequire(import.meta.url);

function loadEnvLocal() {
  try {
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(process.cwd());
  } catch {
    try {
      const dotenv = require("dotenv");
      dotenv.config({ path: resolve(process.cwd(), ".env.local") });
      dotenv.config({ path: resolve(process.cwd(), ".env") });
    } catch {
      /* optional */
    }
  }
}

loadEnvLocal();

class FakeBookingSupabase {
  rows: Record<string, unknown>[] = [];

  from(table: string) {
    if (table === "audit_logs") {
      return { insert: async () => ({ error: null }) };
    }
    const store = this;
    return {
      insert: async (row: Record<string, unknown>) => {
        store.rows.push({ ...row, created_at: new Date().toISOString() });
        return { error: null };
      },
      select(_cols: string) {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq(field: string, val: unknown) {
            filters[field] = val;
            return chain;
          },
          order(_field: string, _opts?: { ascending: boolean }) {
            return chain;
          },
          limit(_n: number) {
            return {
              maybeSingle: async () => {
                const match = store.rows
                  .filter((r) =>
                    Object.entries(filters).every(([k, v]) => r[k] === v)
                  )
                  .sort((a, b) =>
                    String(b.created_at).localeCompare(String(a.created_at))
                  )[0];
                return { data: match ?? null, error: null };
              },
            };
          },
        };
        return chain;
      },
    };
  }
}

function lessonMorningSlots(agendaDate: string): NormalizedWhooshAvailabilitySlot[] {
  return [
    {
      startTime: "2035-06-04T18:00:00.000Z",
      endTime: "2035-06-04T18:30:00.000Z",
      bayOrResourceId: "lesson-slot-1",
      resourceName: "Lesson bay",
      serviceType: "lesson",
      priceEstimate: null,
      raw: { agenda_date: agendaDate },
    },
    {
      startTime: "2035-06-04T18:15:00.000Z",
      endTime: "2035-06-04T18:45:00.000Z",
      bayOrResourceId: "lesson-slot-2",
      resourceName: "Lesson bay",
      serviceType: "lesson",
      priceEstimate: null,
      raw: { agenda_date: agendaDate },
    },
    {
      startTime: "2035-06-04T18:30:00.000Z",
      endTime: "2035-06-04T19:00:00.000Z",
      bayOrResourceId: "lesson-slot-3",
      resourceName: "Lesson bay",
      serviceType: "lesson",
      priceEstimate: null,
      raw: { agenda_date: agendaDate },
    },
  ];
}

function replyFromBookingFlow(flow: BookingFlowAugmentation): string {
  if (flow.kind === "direct_outbound") return flow.replyText;
  if (flow.kind === "appendix") {
    return `[uses OpenAI + runtime notes — run with OPENAI_API_KEY or see appendix in debug]`;
  }
  return `[booking inactive: ${flow.debug?.reason ?? "none"}]`;
}

async function runBookingTurn(input: {
  supabase: FakeBookingSupabase;
  history: ConversationHistoryMessage[];
  inbound: string;
  playbook: string;
}) {
  const flow = await runCloseOsSmsBookingAugmentation({
    supabase: input.supabase as never,
    businessId: "00000000-0000-0000-0000-000000000099",
    conversationId: "00000000-0000-4000-a000-00000000demo",
    contactId: "00000000-0000-4000-a000-00000000c002",
    contactName: "Pat",
    contactPhone: "+15551231234",
    inboundText: input.inbound,
    playbook: input.playbook,
    conversationHistory: input.history,
  });
  return flow;
}

async function runAiTurn(input: {
  history: ConversationHistoryMessage[];
  inbound: string;
  businessName: string;
}) {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return "(skipped — set OPENAI_API_KEY in .env.local to hear the LLM reply)";
  }
  const decision = await generateAiDecision({
    inboundText: input.inbound,
    playbook: decidePlaybook(input.inbound),
    currentState: "qualifying",
    contactName: "Pat",
    channel: "sms",
    businessName: input.businessName,
    assistantName: process.env.CLOSEOS_ASSISTANT_NAME?.trim() || "Front desk",
    shouldDiscloseAutomation: !input.history.some((m) => m.direction === "outbound"),
    sourceOfTruth: buildDefaultAiSourceOfTruth(input.businessName),
    conversationHistory: input.history,
  });
  return decision.reply_text;
}

async function simulateLessonThread() {
  const demoNow = DateTime.fromISO("2035-06-01T12:00:00", {
    zone: "America/Los_Angeles",
  });
  const demoNowMs = demoNow.toMillis();
  Settings.now = () => demoNowMs;

  process.env.WHOOSH_BOOKING_API_ENABLED = "false";

  whooshAvailabilityClient.getAvailability = async (params) => ({
    ok: true,
    slots: lessonMorningSlots(params.date),
    fetchedAtIso: new Date().toISOString(),
    agenda_date: params.date,
    slotRowsLoaded: 3,
    bookingRowsLoaded: 0,
  });

  const supabase = new FakeBookingSupabase();
  const history: ConversationHistoryMessage[] = [];
  const businessName = process.env.CLOSEOS_BUSINESS_NAME?.trim() || "Primetime Golf";

  const turns = [
    "I want to book a golf lesson",
    "Thursday June 4",
    "Adult",
    "30 minutes",
    "morning",
    "1",
    "Sounds good",
    "I want a full hour",
    "Full hour please",
  ];

  console.log("\n=== Demo: lesson booking thread (mock Whoosh, no SMS send) ===\n");

  for (const inbound of turns) {
    const playbook = decidePlaybook(inbound);
    let reply: string;

    const flow = await runBookingTurn({
      supabase,
      history,
      inbound,
      playbook: playbook === "general" ? "lesson" : playbook,
    });

    if (flow.kind === "none" && process.env.OPENAI_API_KEY) {
      reply = await runAiTurn({ history, inbound, businessName });
    } else {
      reply = replyFromBookingFlow(flow);
    }

    console.log(`You: ${inbound}`);
    console.log(`Agent: ${reply}\n`);

    const now = new Date().toISOString();
    history.push({
      direction: "inbound",
      channel: "sms",
      message_text: inbound,
      status: null,
      created_at: now,
    });
    history.push({
      direction: "outbound",
      channel: "sms",
      message_text: reply,
      status: null,
      created_at: now,
    });
  }
}

async function simulateMembershipTurn() {
  const history: ConversationHistoryMessage[] = [];
  const businessName = process.env.CLOSEOS_BUSINESS_NAME?.trim() || "Primetime Golf";
  const inbound = "I want to know about memberships";
  console.log("\n=== Demo: membership (OpenAI) ===\n");
  const reply = await runAiTurn({ history, inbound, businessName });
  console.log(`You: ${inbound}`);
  console.log(`Agent: ${reply}\n`);
}

async function printLiveTestChecklist() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  console.log("\n=== Live SMS test checklist ===\n");
  console.log("1. Copy .env.example → .env.local and fill Supabase, OPENAI_API_KEY, Sent.dm keys.");
  console.log("2. npm run dev");
  console.log(
    "3. Allowlisted real phone: CLOSEOS_LIVE_AGENT_TEST_MODE=true + CLOSEOS_TEST_SMS_ALLOWLIST=+1..."
  );
  console.log("4. npm run qa:live-agent-reply -- --prepare");
  console.log("5. Text your Primetime number OR npm run test:sentdm-webhook:signed (signed webhook)");
  console.log("6. npm run drain:sentdm-webhook-jobs  (if jobs queue)");
  if (url && key) {
    console.log("\nSupabase: configured in this shell.");
  } else {
    console.log("\nSupabase: not configured in this shell — add .env.local for live tests.");
  }
}

async function main() {
  const scenario =
    process.argv.includes("--scenario") ?
      process.argv[process.argv.indexOf("--scenario") + 1] ?? "lesson"
    : "lesson";

  if (scenario === "membership") {
    await simulateMembershipTurn();
  } else {
    await simulateLessonThread();
  }

  await printLiveTestChecklist();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
