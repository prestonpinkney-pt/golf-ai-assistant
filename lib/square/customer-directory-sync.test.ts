import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildSquareIdentityPatchFromDirectory,
  buildSquareIdentityPatchFromRawPayload,
  SQUARE_DIRECTORY_IDENTITY_CONFIDENCE,
  SQUARE_RAW_PAYLOAD_IDENTITY_CONFIDENCE,
} from "./customer-identity";
import { sanitizeSquareCustomerPayload } from "./api";
import { countHighValueReachable } from "./customer-directory-sync";
import { enrichMissingHighValueIdentity } from "./customer-directory-sync";
import {
  computeReachabilityReport,
  isReachableByPhoneOrEmail,
  isTextableForSms,
} from "@/lib/revenue-recovery/reachability";

const NOW = Date.parse("2026-05-22T12:00:00.000Z");

function daysAgoIso(days: number): string {
  return new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();
}

type FakeProfile = Record<string, unknown> & { id: string };

function fakeCustomerProfileSupabase(rows: FakeProfile[]) {
  return {
    from(table: string) {
      assert.strictEqual(table, "customer_profiles");
      return {
        select(_cols: string) {
          const filters: Array<(row: FakeProfile) => boolean> = [];
          const chain = {
            eq(field: string, value: unknown) {
              filters.push((row) => row[field] === value);
              return chain;
            },
            gte(field: string, value: unknown) {
              filters.push((row) => {
                const actual = row[field];
                if (typeof actual === "number" && typeof value === "number") return actual >= value;
                if (typeof actual === "string" && typeof value === "string") return actual >= value;
                return false;
              });
              return chain;
            },
            then(resolve: (value: { data: FakeProfile[]; error: null }) => unknown) {
              return Promise.resolve({
                data: rows.filter((row) => filters.every((f) => f(row))).map((row) => ({ ...row })),
                error: null,
              }).then(resolve);
            },
          };
          return chain;
        },
        update(patch: Record<string, unknown>) {
          return {
            eq(field: string, value: unknown) {
              const row = rows.find((r) => r[field] === value);
              if (row) Object.assign(row, patch);
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

describe("square customer directory sync", () => {
  test("Square customer payload populates customer_profiles fields on insert patch", () => {
    const { patch, filledFieldKeys } = buildSquareIdentityPatchFromDirectory(
      {
        first_name: null,
        last_name: null,
        email: null,
        phone: null,
        identity_confidence: 0,
        identity_sources: [],
        source: "square",
      },
      {
        given_name: "Sam",
        family_name: "Rivers",
        email_address: "sam@primetime.golf",
        phone_number: "5105550199",
      }
    );

    assert.ok(filledFieldKeys.includes("first_name"));
    assert.ok(filledFieldKeys.includes("email"));
    assert.strictEqual(patch.first_name, "Sam");
    assert.strictEqual(patch.last_name, "Rivers");
    assert.strictEqual(patch.email, "sam@primetime.golf");
    assert.strictEqual(patch.phone, "+15105550199");
    assert.strictEqual(patch.identity_confidence, SQUARE_DIRECTORY_IDENTITY_CONFIDENCE);
    assert.deepEqual(patch.identity_sources, ["square_customer_directory"]);
  });

  test("external_customer_id directory match updates existing spend row without blank overwrite", () => {
    const { patch, filledFieldKeys } = buildSquareIdentityPatchFromDirectory(
      {
        first_name: "Pat",
        last_name: "Operator",
        email: "pat@example.com",
        phone: "+14155550100",
        identity_confidence: 95,
        identity_sources: ["square_customer_directory"],
        source: "square",
      },
      {
        given_name: "SquareFirst",
        family_name: "SquareLast",
        email_address: "",
        phone_number: "",
      }
    );

    assert.strictEqual(filledFieldKeys.length, 0);
    assert.strictEqual(patch.email, undefined);
    assert.strictEqual(patch.phone, undefined);
  });

  test("directory fills blanks on spend-only row matched by external_customer_id", () => {
    const { patch, filledFieldKeys } = buildSquareIdentityPatchFromDirectory(
      {
        first_name: null,
        last_name: null,
        email: null,
        phone: null,
        identity_confidence: 0,
        identity_sources: [],
        source: "square",
      },
      {
        given_name: "Spend",
        family_name: "Guest",
        email_address: "guest@primetime.golf",
        phone_number: "5105550100",
      }
    );

    assert.ok(filledFieldKeys.includes("phone"));
    assert.ok(filledFieldKeys.includes("email"));
    assert.strictEqual(patch.identity_confidence, 90);
    assert.deepEqual(patch.identity_sources, ["square_customer_directory"]);
  });

  test("directory overwrites email when incoming confidence is higher", () => {
    const { patch, filledFieldKeys } = buildSquareIdentityPatchFromDirectory(
      {
        email: "old@example.com",
        identity_confidence: SQUARE_RAW_PAYLOAD_IDENTITY_CONFIDENCE,
        identity_sources: ["square_raw_payload"],
        source: "square",
      },
      { email_address: "verified@primetime.golf" }
    );

    assert.ok(filledFieldKeys.includes("email"));
    assert.strictEqual(patch.email, "verified@primetime.golf");
    assert.strictEqual(patch.identity_confidence, SQUARE_DIRECTORY_IDENTITY_CONFIDENCE);
  });

  test("raw_payload backfill fills missing columns", () => {
    const { patch, filledFieldKeys } = buildSquareIdentityPatchFromRawPayload({
      first_name: null,
      phone: null,
      raw_payload: { given_name: "Lee", phone_number: "4155550100" },
      source: "square",
    });

    assert.ok(filledFieldKeys.includes("phone"));
    assert.strictEqual(patch.phone, "+14155550100");
  });

  test("sanitizeSquareCustomerPayload keeps identity fields only", () => {
    const safe = sanitizeSquareCustomerPayload({
      id: "cust_1",
      given_name: "A",
      family_name: "B",
      email_address: "a@b.com",
      phone_number: "+14155550100",
      company_name: "Primetime",
      reference_id: "ref",
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
    });
    assert.strictEqual(safe.id, "cust_1");
    assert.strictEqual(safe.given_name, "A");
    assert.strictEqual(safe.reference_id, "ref");
  });

  test("customer 404 increments skipped_not_found and marks profile unresolved", async () => {
    const nativeFetch = globalThis.fetch;
    const rows: FakeProfile[] = [
      {
        id: "profile-stale",
        business_id: "biz",
        source: "square",
        external_customer_id: "stale-customer",
        first_name: null,
        last_name: null,
        email: null,
        phone: null,
        identity_confidence: 50,
        identity_sources: ["square"],
        raw_payload: {},
        total_spend_cents: 20000,
        last_purchase_at: daysAgoIso(10),
      },
    ];

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/bulk-retrieve")) {
        return new Response(JSON.stringify({ customers: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          errors: [{ code: "NOT_FOUND", detail: "Customer with ID not found." }],
        }),
        { status: 404 }
      );
    };

    try {
      const stats = await enrichMissingHighValueIdentity({
        supabase: fakeCustomerProfileSupabase(rows) as never,
        businessId: "biz",
        accessToken: "token",
        environment: "sandbox",
      });

      assert.strictEqual(stats.skippedNotFound, 1);
      assert.strictEqual(stats.failedOtherErrors, 0);
      assert.strictEqual(rows[0]!.identity_confidence, 0);
      assert.ok((rows[0]!.identity_sources as string[]).includes("square_customer_directory_not_found"));
      const raw = rows[0]!.raw_payload as Record<string, unknown>;
      assert.deepStrictEqual(
        (raw.identity_enrichment_error as Record<string, unknown>).kind,
        "square_customer_not_found"
      );
      assert.strictEqual(
        (raw.identity_enrichment_error as Record<string, unknown>).external_customer_id,
        "stale-customer"
      );
      assert.strictEqual(typeof rows[0]!.last_identity_enriched_at, "string");
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  test("auth 401 still fails", async () => {
    const nativeFetch = globalThis.fetch;
    const rows: FakeProfile[] = [
      {
        id: "profile-auth",
        business_id: "biz",
        source: "square",
        external_customer_id: "auth-customer",
        email: null,
        phone: null,
        identity_confidence: 0,
        identity_sources: [],
        raw_payload: {},
        total_spend_cents: 20000,
        last_purchase_at: daysAgoIso(10),
      },
    ];
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ errors: [{ code: "UNAUTHORIZED" }] }), { status: 401 });

    try {
      await assert.rejects(
        enrichMissingHighValueIdentity({
          supabase: fakeCustomerProfileSupabase(rows) as never,
          businessId: "biz",
          accessToken: "bad-token",
          environment: "sandbox",
        }),
        /Square request failed/
      );
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  test("successful later customer still enriches after earlier 404", async () => {
    const nativeFetch = globalThis.fetch;
    const rows: FakeProfile[] = [
      {
        id: "profile-stale",
        business_id: "biz",
        source: "square",
        external_customer_id: "stale-customer",
        email: null,
        phone: null,
        identity_confidence: 0,
        identity_sources: [],
        raw_payload: {},
        total_spend_cents: 20000,
        last_purchase_at: daysAgoIso(10),
      },
      {
        id: "profile-good",
        business_id: "biz",
        source: "square",
        external_customer_id: "good-customer",
        email: null,
        phone: null,
        identity_confidence: 0,
        identity_sources: [],
        raw_payload: {},
        total_spend_cents: 20000,
        last_purchase_at: daysAgoIso(10),
      },
    ];

    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/bulk-retrieve")) {
        return new Response(JSON.stringify({ customers: [] }), { status: 200 });
      }
      if (url.endsWith("/v2/customers/stale-customer")) {
        return new Response(
          JSON.stringify({ errors: [{ code: "NOT_FOUND", detail: "missing" }] }),
          { status: 404 }
        );
      }
      return new Response(
        JSON.stringify({
          customer: {
            id: "good-customer",
            given_name: "Good",
            family_name: "Customer",
            email_address: "good@example.com",
            phone_number: "5105550100",
          },
        }),
        { status: 200 }
      );
    };

    try {
      const stats = await enrichMissingHighValueIdentity({
        supabase: fakeCustomerProfileSupabase(rows) as never,
        businessId: "biz",
        accessToken: "token",
        environment: "sandbox",
      });

      assert.strictEqual(stats.skippedNotFound, 1);
      assert.strictEqual(stats.fallbackFetched, 1);
      assert.strictEqual(stats.enrichedWithPhone, 1);
      assert.strictEqual(stats.enrichedWithEmail, 1);
      assert.strictEqual(rows[1]!.phone, "+15105550100");
      assert.strictEqual(rows[1]!.email, "good@example.com");
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });
});

describe("revenue recovery reachability after enrichment", () => {
  test("textable count increases when phone is resolved from payload", () => {
    const before = computeReachabilityReport([
      {
        source: "square",
        total_spend_cents: 15000,
        last_purchase_at: daysAgoIso(90),
        phone: null,
        email: null,
        raw_payload: null,
      },
    ]);

    const after = computeReachabilityReport([
      {
        source: "square",
        total_spend_cents: 15000,
        last_purchase_at: daysAgoIso(90),
        phone: null,
        email: null,
        raw_payload: { phone_number: "5105551212", given_name: "Jordan" },
      },
    ]);

    assert.strictEqual(before.square130PlusReachable, 0);
    assert.strictEqual(after.square130PlusReachable, 1);
    assert.strictEqual(after.revenueRecoveryWarmInactiveTextableCount, 1);
    assert.ok(isTextableForSms("+15105551212"));
    assert.ok(isReachableByPhoneOrEmail("+15105551212", null));
  });

  test("countHighValueReachable matches resolved profiles", () => {
    const n = countHighValueReachable(
      [
        {
          source: "square",
          total_spend_cents: 20000,
          last_purchase_at: daysAgoIso(100),
          raw_payload: { email_address: "guest@test.com" },
        },
      ],
      NOW
    );
    assert.strictEqual(n, 1);
  });

  test("opted-out and exclude_from_ai_targeting stay out of warm inactive textable queue", () => {
    const report = computeReachabilityReport([
      {
        source: "square",
        total_spend_cents: 20000,
        last_purchase_at: daysAgoIso(90),
        phone: "+15105551212",
        exclude_from_ai_targeting: true,
      },
      {
        source: "square",
        total_spend_cents: 20000,
        last_purchase_at: daysAgoIso(90),
        phone: "+15105559999",
        sms_opt_out: true,
      },
    ]);

    assert.strictEqual(report.revenueRecoveryWarmInactiveCount, 0);
    assert.strictEqual(report.revenueRecoveryWarmInactiveTextableCount, 0);
  });
});
