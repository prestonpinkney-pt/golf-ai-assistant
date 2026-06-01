import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildCloseOsAiRecommendation } from "@/app/api/lib/closeos-ai-intelligence";
import { getWhooshAvailability } from "@/lib/whoosh/availability-windows";
import { mapWhooshCacheRowToWindow } from "@/lib/whoosh/load-availability-windows";
import { refreshWhooshSlowTimeOpportunities } from "@/lib/whoosh/slow-time-opportunities";

const savedFetch = globalThis.fetch;
const savedEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = savedFetch;
  process.env = { ...savedEnv };
});

function createSlowTimeMockSupabase() {
  const insertedOpportunities: Record<string, unknown>[] = [];
  const tables: Record<string, Record<string, unknown>[]> = {
    whoosh_availability_windows: [
      {
        whoosh_window_id: "2026-06-03:bay-1:12:00",
        business_id: "biz-1",
        starts_at: "2026-06-03T19:00:00.000Z",
        ends_at: "2026-06-03T20:00:00.000Z",
        timezone: "America/Los_Angeles",
        resource_id: "bay-1",
        resource_name: "Simulator 1",
        resource_type: "simulator",
        bookable: true,
        capacity: 2,
        raw: {},
      },
    ],
    customer_profiles: [
      {
        id: "profile-biz-1",
        business_id: "biz-1",
        phone: "+15551110000",
        exclude_from_ai_targeting: false,
        visit_count: 3,
        total_spend_cents: 12000,
        last_purchase_at: "2026-05-01T00:00:00.000Z",
      },
      {
        id: "profile-other-business",
        business_id: "biz-2",
        phone: "+15552220000",
        exclude_from_ai_targeting: false,
        visit_count: 8,
        total_spend_cents: 40000,
        last_purchase_at: "2026-05-31T00:00:00.000Z",
      },
    ],
    ai_opportunities: [],
  };

  type Filter = { field: string; op: string; value: unknown };

  function filterRows(table: string, filters: Filter[]) {
    return (tables[table] ?? []).filter((row) =>
      filters.every((f) => {
        const value = row[f.field];
        if (f.op === "eq") return value === f.value;
        if (f.op === "in") {
          return Array.isArray(f.value) && f.value.includes(value);
        }
        if (f.op === "not:is") return value !== null && value !== undefined;
        if (f.op === "gte") {
          return typeof value !== "string" || typeof f.value !== "string" || value >= f.value;
        }
        if (f.op === "lte") {
          return typeof value !== "string" || typeof f.value !== "string" || value <= f.value;
        }
        return true;
      })
    );
  }

  const supabase = {
    from(table: string) {
      const filters: Filter[] = [];
      let pendingUpdate: Record<string, unknown> | null = null;

      const api = {
        select() {
          return api;
        },
        eq(field: string, value: unknown) {
          filters.push({ field, op: "eq", value });
          return api;
        },
        in(field: string, value: unknown) {
          filters.push({ field, op: "in", value });
          return api;
        },
        not(field: string, op: string, value: unknown) {
          filters.push({ field, op: `not:${op}`, value });
          return api;
        },
        gte(field: string, value: unknown) {
          filters.push({ field, op: "gte", value });
          return api;
        },
        lte(field: string, value: unknown) {
          filters.push({ field, op: "lte", value });
          return api;
        },
        order() {
          return api;
        },
        limit() {
          return api;
        },
        update(patch: Record<string, unknown>) {
          pendingUpdate = patch;
          return api;
        },
        insert(row: Record<string, unknown>) {
          if (table === "ai_opportunities") {
            insertedOpportunities.push(row);
          }
          return { error: null };
        },
        async maybeSingle() {
          const rows = filterRows(table, filters);
          if (pendingUpdate) {
            Object.assign(rows[0] ?? {}, pendingUpdate);
            return { data: rows[0] ?? null, error: null };
          }
          return { data: rows[0] ?? null, error: null };
        },
        then(
          onFulfilled?: (value: { data: Record<string, unknown>[]; error: null }) => unknown,
          onRejected?: (reason: unknown) => unknown
        ) {
          return Promise.resolve({ data: filterRows(table, filters), error: null }).then(
            onFulfilled,
            onRejected
          );
        },
      };
      return api;
    },
    _insertedOpportunities: insertedOpportunities,
  };

  return supabase;
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

test("getWhooshAvailability excludes non-public simulator slots from SMS campaigns", async () => {
  process.env.WHOOSH_API_TOKEN = "token";
  process.env.WHOOSH_API_BASE_URL = "https://whoosh.test";
  process.env.WHOOSH_FACILITY_SLUG = "facility-1";

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        slots: [
          {
            id: "monday-slot",
            time: "12:00",
            course_name: "Simulator Bay 1",
            type: "simulator",
            capacity: 2,
            used_capacity: 0,
          },
        ],
      }),
      { status: 200 }
    );

  const result = await getWhooshAvailability({
    startDate: "2026-06-01",
    endDate: "2026-06-01",
    resourceType: "simulator",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.windows.length, 0);
});

test("refreshWhooshSlowTimeOpportunities only targets profiles for the syncing business", async () => {
  const supabase = createSlowTimeMockSupabase();

  const result = await refreshWhooshSlowTimeOpportunities({
    supabase: supabase as never,
    businessId: "biz-1",
    startDate: "2026-06-03",
    endDate: "2026-06-03",
  });

  assert.equal(result.opportunitiesUpserted, 1);
  assert.deepEqual(
    supabase._insertedOpportunities.map((row) => row.customer_profile_id),
    ["profile-biz-1"]
  );
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
