import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
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

test("Whoosh slow-time opportunities only target profiles from the active business", async () => {
  type QueryFilter =
    | { op: "eq"; column: string; value: unknown }
    | { op: "not"; column: string; operator: string; value: unknown }
    | { op: "in"; column: string; values: unknown[] };
  type QueryRecord = {
    table: string;
    filters: QueryFilter[];
    limitCount: number | null;
  };

  const queries: QueryRecord[] = [];
  const inserted: Record<string, unknown>[] = [];
  const tables: Record<string, Record<string, unknown>[]> = {
    whoosh_availability_windows: [
      {
        whoosh_window_id: "window-1",
        business_id: "biz-1",
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
    customer_profiles: [
      {
        id: "target-profile",
        business_id: "biz-1",
        phone: "+15551234567",
        exclude_from_ai_targeting: false,
        last_purchase_at: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "other-business-profile",
        business_id: "biz-2",
        phone: "+15557654321",
        exclude_from_ai_targeting: false,
        last_purchase_at: "2026-05-02T00:00:00.000Z",
      },
    ],
    ai_opportunities: [],
  };

  function rowsFor(record: QueryRecord) {
    let rows = [...(tables[record.table] ?? [])];
    for (const filter of record.filters) {
      if (filter.op === "eq") {
        rows = rows.filter((row) => row[filter.column] === filter.value);
      } else if (filter.op === "not") {
        if (filter.operator === "is" && filter.value === null) {
          rows = rows.filter((row) => row[filter.column] !== null);
        }
      } else if (filter.op === "in") {
        rows = rows.filter((row) => filter.values.includes(row[filter.column]));
      }
    }
    return record.limitCount == null ? rows : rows.slice(0, record.limitCount);
  }

  const supabase = {
    from(table: string) {
      const record: QueryRecord = { table, filters: [], limitCount: null };
      queries.push(record);
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          record.filters.push({ op: "eq", column, value });
          return query;
        },
        not(column: string, operator: string, value: unknown) {
          record.filters.push({ op: "not", column, operator, value });
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
        in(column: string, values: unknown[]) {
          record.filters.push({ op: "in", column, values });
          return query;
        },
        limit(limitCount: number) {
          record.limitCount = limitCount;
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null });
        },
        insert(payload: Record<string, unknown>) {
          inserted.push(payload);
          return Promise.resolve({ error: null });
        },
        update() {
          return query;
        },
        then(
          resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown,
          reject?: (reason: unknown) => unknown
        ) {
          return Promise.resolve({ data: rowsFor(record), error: null }).then(
            resolve,
            reject
          );
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;

  const result = await refreshWhooshSlowTimeOpportunities({
    supabase,
    businessId: "biz-1",
    startDate: "2026-05-28",
    endDate: "2026-05-28",
  });

  const profileQuery = queries.find((query) => query.table === "customer_profiles");
  assert.ok(
    profileQuery?.filters.some(
      (filter) =>
        filter.op === "eq" &&
        filter.column === "business_id" &&
        filter.value === "biz-1"
    )
  );
  assert.equal(result.opportunitiesUpserted, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.business_id, "biz-1");
  assert.equal(inserted[0]?.customer_profile_id, "target-profile");
});
