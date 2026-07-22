import assert from "node:assert/strict";
import test from "node:test";
import { buildCloseOsAiRecommendation } from "@/app/api/lib/closeos-ai-intelligence";
import { mapWhooshCacheRowToWindow } from "@/lib/whoosh/load-availability-windows";
import { refreshWhooshSlowTimeOpportunities } from "@/lib/whoosh/slow-time-opportunities";

test("mapWhooshCacheRowToWindow normalizes Supabase cache rows", () => {
  const window = mapWhooshCacheRowToWindow({
    whoosh_window_id: "2026-05-28:bay-1:11:00",
    starts_at: "2026-05-28T18:00:00.000Z",
    ends_at: "2026-05-28T19:00:00.000Z",
    timezone: "America/Los_Angeles",
    resource_id: "bay-1",
    resource_name: "Simulator 1",
    resource_type: "simulator",
    bookable: true,
    capacity: 1,
    raw: { slot: true },
  });

  assert.equal(window.source, "whoosh");
  assert.equal(window.id, "2026-05-28:bay-1:11:00");
  assert.equal(window.resourceType, "simulator");
  assert.equal(window.bookable, true);
  assert.equal(window.resourceName, "Simulator 1");
});

test("Whoosh-verified slow-time SMS does not promise exact tee times", () => {
  const rec = buildCloseOsAiRecommendation({
    opportunity: {
      id: "opp-1",
      recognized_opportunity: "weekday_open_bay_fill",
      playbook: "weekday-simulator-fill",
      opportunity_type: "slow_time",
      source: "whoosh_availability",
      confidence: 82,
      estimated_revenue_cents: 4500,
      signal_summary: "Whoosh verified windows",
      next_best_action: null,
      reply_handling_goal: null,
      recommended_message: null,
    },
    customer: {
      first_name: "Alex",
      last_name: null,
      leadName: "Alex",
      email: null,
      phone: "+15551234567",
      is_member: false,
      total_spend_cents: 5000,
      visit_count: 2,
      last_purchase_at: null,
    },
    bookingContext: null,
    sourceDisplayLabel: "Whoosh",
    whooshAvailability: {
      verified: true,
      hasExactTimes: false,
      daypart: "weekday",
    },
  });

  assert.ok(!rec.recommendedMessage.match(/\d{1,2}:\d{2}/));
  assert.ok(!rec.recommendedMessage.toLowerCase().includes("at 11"));
  assert.ok(rec.recommendedMessage.includes("weekday simulator windows"));
  assert.ok(rec.recommendedMessage.length <= 300);
});

test("Whoosh-verified Sunday copy uses Sunday wording without exact times", () => {
  const rec = buildCloseOsAiRecommendation({
    opportunity: {
      id: "opp-2",
      recognized_opportunity: "sunday_open_bay_fill",
      playbook: "sunday-simulator-fill",
      opportunity_type: "slow_time",
      source: "whoosh_availability",
      confidence: 82,
      estimated_revenue_cents: 4500,
      signal_summary: null,
      next_best_action: null,
      reply_handling_goal: null,
      recommended_message: null,
    },
    customer: {
      first_name: "Sam",
      last_name: null,
      leadName: "Sam",
      email: null,
      phone: "+15559876543",
      is_member: false,
      total_spend_cents: 0,
      visit_count: 0,
      last_purchase_at: null,
    },
    bookingContext: null,
    sourceDisplayLabel: "Whoosh",
    whooshAvailability: {
      verified: true,
      hasExactTimes: false,
      daypart: "sunday",
    },
  });

  assert.ok(rec.recommendedMessage.includes("Sunday"));
  assert.ok(!rec.recommendedMessage.match(/\d{1,2}:\d{2}/));
});

test("slow-time opportunities only use profiles from the requested business", async () => {
  const insertedOpportunities: Record<string, unknown>[] = [];
  const profiles = [
    {
      id: "profile-a",
      business_id: "biz-a",
      phone: "+15551111111",
      exclude_from_ai_targeting: false,
      visit_count: 2,
      total_spend_cents: 5000,
    },
    {
      id: "profile-b",
      business_id: "biz-b",
      phone: "+15552222222",
      exclude_from_ai_targeting: false,
      visit_count: 3,
      total_spend_cents: 7500,
    },
  ];

  const supabase = {
    from(table: string) {
      if (table === "whoosh_availability_windows") {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          gte() {
            return query;
          },
          lte() {
            return query;
          },
          order() {
            return query;
          },
          in: async () => ({
            data: [
              {
                whoosh_window_id: "window-1",
                starts_at: "2026-07-23T18:00:00.000Z",
                ends_at: "2026-07-23T19:00:00.000Z",
                timezone: "America/Los_Angeles",
                resource_type: "simulator",
                bookable: true,
              },
            ],
            error: null,
          }),
        };
        return query;
      }

      if (table === "customer_profiles") {
        let businessId: string | null = null;
        const query = {
          select() {
            return query;
          },
          eq(column: string, value: unknown) {
            if (column === "business_id") businessId = String(value);
            return query;
          },
          not() {
            return query;
          },
          order() {
            return query;
          },
          limit: async () => ({
            data: businessId
              ? profiles.filter((profile) => profile.business_id === businessId)
              : profiles,
            error: null,
          }),
        };
        return query;
      }

      if (table === "ai_opportunities") {
        const selectQuery = {
          eq() {
            return selectQuery;
          },
          in() {
            return selectQuery;
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return {
          select() {
            return selectQuery;
          },
          insert: async (payload: Record<string, unknown>) => {
            insertedOpportunities.push(payload);
            return { error: null };
          },
        };
      }

      throw new Error(`Unexpected table ${table}`);
    },
  };

  const result = await refreshWhooshSlowTimeOpportunities({
    supabase: supabase as never,
    businessId: "biz-a",
    startDate: "2026-07-23",
    endDate: "2026-07-30",
  });

  assert.equal(result.opportunitiesUpserted, 1);
  assert.deepEqual(
    insertedOpportunities.map((row) => row.customer_profile_id),
    ["profile-a"]
  );
  assert.equal(insertedOpportunities[0]?.business_id, "biz-a");
});
