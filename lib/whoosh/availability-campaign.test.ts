import assert from "node:assert/strict";
import test from "node:test";
import { buildCloseOsAiRecommendation } from "@/app/api/lib/closeos-ai-intelligence";
import { mapWhooshCacheRowToWindow } from "@/lib/whoosh/load-availability-windows";
import { refreshWhooshSlowTimeOpportunities } from "@/lib/whoosh/slow-time-opportunities";

type FakeRow = Record<string, unknown>;

function createWhooshOpportunitySupabase(input: {
  windows: FakeRow[];
  profiles: FakeRow[];
}) {
  const insertedOpportunities: FakeRow[] = [];

  function selectRows(table: string) {
    if (table === "whoosh_availability_windows") return input.windows;
    if (table === "customer_profiles") return input.profiles;
    if (table === "ai_opportunities") return insertedOpportunities;
    throw new Error(`Unexpected table ${table}`);
  }

  function createSelectQuery(table: string) {
    const filters: Array<(row: FakeRow) => boolean> = [];
    let limitCount: number | null = null;

    const chain = {
      eq(field: string, value: unknown) {
        filters.push((row) => row[field] === value);
        return chain;
      },
      not(field: string, operator: string, value: unknown) {
        filters.push((row) => {
          if (operator === "is" && value === null) {
            return row[field] !== null && row[field] !== undefined;
          }
          return true;
        });
        return chain;
      },
      gte(field: string, value: unknown) {
        filters.push((row) => {
          const actual = row[field];
          if (typeof actual !== "string" || typeof value !== "string") return false;
          return actual >= value;
        });
        return chain;
      },
      lte(field: string, value: unknown) {
        filters.push((row) => {
          const actual = row[field];
          if (typeof actual !== "string" || typeof value !== "string") return false;
          return actual <= value;
        });
        return chain;
      },
      in(field: string, values: unknown[]) {
        filters.push((row) => values.includes(row[field]));
        return chain;
      },
      order() {
        return chain;
      },
      limit(count: number) {
        limitCount = count;
        return chain;
      },
      maybeSingle: async () => ({
        data:
          selectRows(table).filter((row) => filters.every((f) => f(row)))[0] ??
          null,
        error: null,
      }),
      then(resolve: (value: { data: FakeRow[]; error: null }) => unknown) {
        const data = selectRows(table)
          .filter((row) => filters.every((f) => f(row)))
          .slice(0, limitCount ?? undefined)
          .map((row) => ({ ...row }));
        return Promise.resolve({ data, error: null }).then(resolve);
      },
    };

    return chain;
  }

  const supabase = {
    from(table: string) {
      return {
        select() {
          return createSelectQuery(table);
        },
        insert(row: FakeRow) {
          if (table !== "ai_opportunities") {
            throw new Error(`Unexpected insert into ${table}`);
          }
          insertedOpportunities.push({ ...row });
          return { error: null };
        },
        update(patch: FakeRow) {
          return {
            eq(field: string, value: unknown) {
              const row = insertedOpportunities.find(
                (candidate) => candidate[field] === value
              );
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
    insertedOpportunities,
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

test("Whoosh slow-time refresh only targets profiles for the requested business", async () => {
  const supabase = createWhooshOpportunitySupabase({
    windows: [
      {
        business_id: "biz-a",
        whoosh_window_id: "2026-06-10:bay-1:11:00",
        starts_at: "2026-06-10T18:00:00.000Z",
        ends_at: "2026-06-10T19:00:00.000Z",
        timezone: "America/Los_Angeles",
        resource_id: "bay-1",
        resource_name: "Simulator 1",
        resource_type: "simulator",
        bookable: true,
        capacity: 1,
        raw: {},
      },
    ],
    profiles: [
      {
        id: "profile-a",
        business_id: "biz-a",
        phone: "+15551111111",
        exclude_from_ai_targeting: false,
        visit_count: 3,
        total_spend_cents: 12000,
      },
      {
        id: "profile-b",
        business_id: "biz-b",
        phone: "+15552222222",
        exclude_from_ai_targeting: false,
        visit_count: 5,
        total_spend_cents: 20000,
      },
    ],
  });

  const result = await refreshWhooshSlowTimeOpportunities({
    supabase: supabase as never,
    businessId: "biz-a",
    startDate: "2026-06-10",
    endDate: "2026-06-11",
  });

  assert.equal(result.opportunitiesUpserted, 1);
  assert.equal(supabase.insertedOpportunities.length, 1);
  assert.equal(supabase.insertedOpportunities[0]?.business_id, "biz-a");
  assert.equal(supabase.insertedOpportunities[0]?.customer_profile_id, "profile-a");
});
