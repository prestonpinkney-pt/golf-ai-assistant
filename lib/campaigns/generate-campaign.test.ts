import assert from "node:assert/strict";
import test from "node:test";
import type { OutboundOpportunityTarget } from "@/app/api/lib/opportunity-eligible-targets";
import {
  filterTargetsByCampaignFocus,
  isWhooshVerifiedTarget,
} from "@/lib/campaigns/campaign-focus";
import {
  formatCampaignsErrorBanner,
  formatCampaignsSetupBanner,
  resolveCampaignsListUiState,
} from "./campaigns-ui-state";
import {
  generateAiCampaignDraft,
  pickAiCampaignTargetGroup,
} from "./generate-campaign";
import { diagnoseCampaignsPostgrestError } from "./setup-diagnostics";

function sampleTarget(
  overrides: Partial<OutboundOpportunityTarget> & { opportunityId: string; phone: string }
): OutboundOpportunityTarget {
  return {
    id: overrides.opportunityId,
    opportunityId: overrides.opportunityId,
    targetingProfileId: null,
    customerProfileId: "cust-1",
    externalCustomerId: "sq-1",
    opportunitySource: "square",
    sourceDisplayLabel: "Square",
    leadName: "Alex",
    email: null,
    phone: overrides.phone,
    isMember: false,
    totalSpendCents: 10000,
    visitCount: 2,
    lastPurchaseAt: null,
    targetScore: overrides.targetScore ?? 80,
    confidence: 0.9,
    opportunityType: "lesson",
    estimatedRevenueCents: overrides.estimatedRevenueCents ?? 5000,
    playbook: overrides.playbook ?? "lesson_follow_up",
    status: "open",
    recommendedOffer: "Lesson",
    reason: "Recent visit",
    recommendedMessage: overrides.recommendedMessage ?? "Want a lesson slot?",
    recognizedOpportunity: overrides.recognizedOpportunity ?? "lesson",
    opportunitySignalSummary: "Practice spike",
    nextBestAction: "Offer lesson",
    replyHandlingGoal: "Book",
    recommendedCampaign: overrides.recommendedCampaign ?? "Lesson follow-up",
    recommendedChannel: "sms",
    aiConfidenceReason: "High intent",
    objectionHandlingNotes: "",
    followUpPlan: "Nudge in 3 days",
    lastBookingAt: null,
    lastBookingType: null,
    bookingStatus: null,
    bookingTitle: null,
    daysSinceBooking: null,
    revenueReviewRequired: false,
    countsTowardPipeline: true,
    pipelineCategory: "known_pipeline",
    offerKey: null,
    knownPipelineContributionCents: 5000,
    availabilitySource: overrides.availabilitySource ?? null,
    availabilityVerified: overrides.availabilityVerified ?? false,
  };
}

function createMockSupabase() {
  const insertedMessages: Record<string, unknown>[] = [];
  const campaignRow = {
    id: "camp-ai-001",
    business_id: "biz-1",
    name: "Lesson follow-up · 2026-05-24",
    status: "draft",
    source: "ai_generated",
  };

  const supabase = {
    from(table: string) {
      if (table === "campaigns") {
        return {
          insert() {
            return {
              select() {
                return {
                  single: async () => ({ data: campaignRow, error: null }),
                };
              },
            };
          },
          delete() {
            return { eq: async () => ({ error: null }) };
          },
          select() {
            return {
              eq() {
                return {
                  single: async () => ({ data: campaignRow, error: null }),
                };
              },
            };
          },
          update() {
            return { eq: async () => ({ error: null }) };
          },
        };
      }

      if (table === "campaign_messages") {
        return {
          insert(rows: Record<string, unknown>[]) {
            insertedMessages.push(...rows);
            return { error: null };
          },
          select() {
            return {
              eq: async () => ({ data: insertedMessages, error: null }),
            };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
    _insertedMessages: insertedMessages,
  };

  return supabase;
}

test("pickAiCampaignTargetGroup chooses highest-value campaign group", () => {
  const targets = [
    sampleTarget({
      opportunityId: "opp-a",
      phone: "+15551111111",
      recommendedCampaign: "Membership",
      estimatedRevenueCents: 1000,
      targetScore: 50,
    }),
    sampleTarget({
      opportunityId: "opp-b",
      phone: "+15552222222",
      recommendedCampaign: "Lesson follow-up",
      estimatedRevenueCents: 9000,
      targetScore: 90,
    }),
  ];

  const { picked, groupLabel } = pickAiCampaignTargetGroup(targets);
  assert.equal(picked.length, 1);
  assert.equal(picked[0]?.opportunityId, "opp-b");
  assert.equal(groupLabel, "Lesson follow-up");
});

test("generateAiCampaignDraft returns no_targets when none eligible", async () => {
  const supabase = createMockSupabase();
  const result = await generateAiCampaignDraft({
    supabase: supabase as never,
    businessId: "biz-1",
    userId: "user-1",
    loadTargets: async () => [],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "no_targets");
});

test("generateAiCampaignDraft creates draft campaign and draft messages", async () => {
  const supabase = createMockSupabase();
  const targets = [
    sampleTarget({
      opportunityId: "opp-1",
      phone: "+15553334444",
      recommendedMessage: "Book your next lesson?",
    }),
  ];

  const result = await generateAiCampaignDraft({
    supabase: supabase as never,
    businessId: "biz-1",
    userId: "user-1",
    loadTargets: async () => targets,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.messagesCreated, 1);
  assert.equal(result.campaign.status, "draft");
  assert.equal(result.campaign.source, "ai_generated");

  const rows = supabase._insertedMessages;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "draft");
  assert.equal(rows[0]?.message_text, "Book your next lesson?");
  assert.equal(rows[0]?.phone, "+15553334444");
});

test("generateAiCampaignDraft does not import or call SMS send path", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./generate-campaign.ts", import.meta.url), "utf8")
  );
  assert.equal(source.includes("sendMessage"), false);
  assert.equal(source.includes("sendSentDmMessage"), false);
  assert.equal(source.includes("campaigns/[campaignId]/send"), false);
  assert.equal(source.includes("campaigns/[campaignId]/approve"), false);
});

test("diagnoseCampaignsPostgrestError flags missing campaigns table", () => {
  const diagnosis = diagnoseCampaignsPostgrestError(
    'Could not find the table "public.campaigns" in the schema cache'
  );
  assert.equal(diagnosis.setupRequired, true);
  assert.deepEqual(diagnosis.missing, ["campaigns"]);
});

test("resolveCampaignsListUiState surfaces setupRequired instead of generic error", () => {
  const state = resolveCampaignsListUiState(true, {
    setupRequired: true,
    setupMessage: "Apply campaigns migration",
    missing: ["campaigns"],
  });

  assert.equal(state.error, null);
  assert.equal(state.setupMessage, "Apply campaigns migration");
  assert.equal(formatCampaignsSetupBanner(state).includes("campaigns"), true);
});

test("filterTargetsByCampaignFocus slow_time requires Whoosh-verified targets", () => {
  const verified = sampleTarget({
    opportunityId: "opp-w1",
    phone: "+15551112222",
    recognizedOpportunity: "weekday_open_bay_fill",
    availabilitySource: "whoosh",
    availabilityVerified: true,
  });
  const unverified = sampleTarget({
    opportunityId: "opp-w2",
    phone: "+15553334444",
    recognizedOpportunity: "weekday_open_bay_fill",
    availabilityVerified: false,
  });

  const filtered = filterTargetsByCampaignFocus(
    [verified, unverified],
    "slow_time"
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.opportunityId, "opp-w1");
  assert.equal(isWhooshVerifiedTarget(verified), true);
});

test("generateAiCampaignDraft slow_time refuses without Whoosh availability", async () => {
  const supabase = createMockSupabase();
  const lessonOnly = sampleTarget({
    opportunityId: "opp-lesson",
    phone: "+15556667777",
    recognizedOpportunity: "lesson_rebooking_due",
    recommendedCampaign: "Lessons",
  });

  const result = await generateAiCampaignDraft({
    supabase: supabase as never,
    businessId: "biz-1",
    userId: "user-1",
    campaignFocus: "slow_time",
    loadTargets: async () => [lessonOnly],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "whoosh_availability_required");
  assert.equal(result.errorCode, "whoosh_availability_required");
});

test("generateAiCampaignDraft slow_time generates with Whoosh-verified targets", async () => {
  const supabase = createMockSupabase();
  const whooshTarget = sampleTarget({
    opportunityId: "opp-slow",
    phone: "+15558889999",
    recognizedOpportunity: "sunday_open_bay_fill",
    availabilitySource: "whoosh",
    availabilityVerified: true,
    recommendedCampaign: "Fill Simulator Time",
    recommendedMessage:
      "Hi Alex, this is Primetime Golf. Sunday has a few good simulator windows if you want to get a round in without the rush. Want me to send a couple options?",
  });

  const result = await generateAiCampaignDraft({
    supabase: supabase as never,
    businessId: "biz-1",
    userId: "user-1",
    campaignFocus: "slow_time",
    maxTargets: 25,
    loadTargets: async () => [whooshTarget],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.messagesCreated, 1);
  assert.equal(result.campaign.status, "draft");
});

test("generateAiCampaignDraft lessons focus still works without Whoosh", async () => {
  const supabase = createMockSupabase();
  const lessonTarget = sampleTarget({
    opportunityId: "opp-lesson-2",
    phone: "+15550001111",
    recognizedOpportunity: "lesson_rebooking_due",
    recommendedCampaign: "Lesson follow-up",
  });

  const result = await generateAiCampaignDraft({
    supabase: supabase as never,
    businessId: "biz-1",
    userId: "user-1",
    campaignFocus: "lessons",
    loadTargets: async () => [lessonTarget],
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.messagesCreated, 1);
});

test("resolveCampaignsListUiState shows API error with debug detail in development", () => {
  const state = resolveCampaignsListUiState(false, {
    error: "Schema mismatch",
    debugError: 'column "business_id" does not exist',
  });
  const banner = formatCampaignsErrorBanner({
    ...state,
    debugError: 'column "business_id" does not exist',
  });
  if (process.env.NODE_ENV === "development") {
    assert.equal(
      banner,
      'Schema mismatch — column "business_id" does not exist'
    );
  } else {
    assert.equal(banner, "Schema mismatch");
  }
});
