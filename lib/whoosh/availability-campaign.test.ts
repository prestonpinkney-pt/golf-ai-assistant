import assert from "node:assert/strict";
import test from "node:test";
import { buildCloseOsAiRecommendation } from "@/app/api/lib/closeos-ai-intelligence";
import { mapWhooshCacheRowToWindow } from "@/lib/whoosh/load-availability-windows";
import { refreshWhooshSlowTimeOpportunities } from "@/lib/whoosh/slow-time-opportunities";

function createThenableQuery<T>(
  result: T,
  hooks?: {
    onSelect?: (columns: string) => void;
    onUpdate?: (payload: Record<string, unknown>) => void;
    onEq?: (column: string, value: unknown) => void;
    onIn?: (column: string, value: unknown[]) => void;
  }
) {
  return {
    select(columns = "*") {
      hooks?.onSelect?.(columns);
      return this;
    },
    update(payload: Record<string, unknown>) {
      hooks?.onUpdate?.(payload);
      return this;
    },
    eq(column: string, value: unknown) {
      hooks?.onEq?.(column, value);
      return this;
    },
    gte() {
      return this;
    },
    lte() {
      return this;
    },
    not() {
      return this;
    },
    order() {
      return this;
    },
    limit() {
      return this;
    },
    in(column: string, value: unknown[]) {
      hooks?.onIn?.(column, value);
      return this;
    },
    then(resolve: (value: T) => unknown, reject: (reason?: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
}

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

test("refreshWhooshSlowTimeOpportunities scopes customer profiles to the business", async () => {
  const customerProfileEqCalls: Array<[string, unknown]> = [];
  const supabase = {
    from(table: string) {
      if (table === "whoosh_availability_windows") {
        return createThenableQuery({
          data: [
            {
              whoosh_window_id: "2026-05-28:bay-1:11:00",
              starts_at: "2026-05-28T18:00:00.000Z",
              ends_at: "2026-05-28T19:00:00.000Z",
              timezone: "America/Los_Angeles",
              resource_id: "bay-1",
              resource_name: "Simulator 1",
              resource_type: "simulator",
              bookable: true,
              capacity: 1,
              raw: {},
            },
          ],
          error: null,
        });
      }
      if (table === "customer_profiles") {
        return createThenableQuery(
          { data: [], error: null },
          {
            onEq(column, value) {
              customerProfileEqCalls.push([column, value]);
            },
          }
        );
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };

  await refreshWhooshSlowTimeOpportunities({
    supabase: supabase as never,
    businessId: "biz-1",
    startDate: "2026-05-28",
    endDate: "2026-05-28",
  });

  assert.ok(
    customerProfileEqCalls.some(
      ([column, value]) => column === "business_id" && value === "biz-1"
    )
  );
});

test("refreshWhooshSlowTimeOpportunities stales open Whoosh opportunities when no windows remain", async () => {
  let stalePayload: Record<string, unknown> | null = null;
  const eqCalls: Array<[string, unknown]> = [];
  const inCalls: Array<[string, unknown[]]> = [];
  const supabase = {
    from(table: string) {
      if (table === "whoosh_availability_windows") {
        return createThenableQuery({ data: [], error: null });
      }
      if (table === "ai_opportunities") {
        return createThenableQuery(
          { data: null, error: null },
          {
            onUpdate(payload) {
              stalePayload = payload;
            },
            onEq(column, value) {
              eqCalls.push([column, value]);
            },
            onIn(column, value) {
              inCalls.push([column, value]);
            },
          }
        );
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };

  const result = await refreshWhooshSlowTimeOpportunities({
    supabase: supabase as never,
    businessId: "biz-1",
    startDate: "2026-05-28",
    endDate: "2026-05-28",
  });

  assert.equal(result.windowCount, 0);
  assert.ok(stalePayload);
  assert.equal((stalePayload as Record<string, unknown>).status, "stale");
  assert.ok(eqCalls.some(([column, value]) => column === "business_id" && value === "biz-1"));
  assert.ok(eqCalls.some(([column, value]) => column === "source" && value === "whoosh_availability"));
  assert.ok(
    inCalls.some(
      ([column, value]) =>
        column === "status" &&
        value.includes("open") &&
        value.includes("queued")
    )
  );
});
