import assert from "node:assert/strict";
import { describe, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-test-key";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service-role-test-key";

describe("Square cron route contracts", () => {
  test("Vercel can invoke Square revenue sync with GET", async () => {
    const squareRevenueCron = await import("./square-revenue-sync/route");

    assert.equal(typeof squareRevenueCron.GET, "function");
    assert.equal(typeof squareRevenueCron.POST, "function");
  });

  test("customer directory cron targets an implemented integration route", async () => {
    const squareCustomerDirectoryCron = await import(
      "./square-customer-directory/route"
    );
    const legacySquareCron = await import("./sync-square/route");
    const squareCustomerDirectoryIntegration = await import(
      "../integrations/square/sync-customer-directory/route"
    );

    assert.equal(typeof squareCustomerDirectoryCron.GET, "function");
    assert.equal(typeof squareCustomerDirectoryCron.POST, "function");
    assert.equal(typeof legacySquareCron.GET, "function");
    assert.equal(typeof squareCustomerDirectoryIntegration.POST, "function");
  });
});
