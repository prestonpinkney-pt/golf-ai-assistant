import assert from "node:assert/strict";
import { describe, test } from "node:test";

import * as squareCustomerDirectoryCron from "./square-customer-directory/route";
import * as squareRevenueCron from "./square-revenue-sync/route";
import * as legacySquareCron from "./sync-square/route";
import * as squareCustomerDirectoryIntegration from "../integrations/square/sync-customer-directory/route";

describe("Square cron route contracts", () => {
  test("Vercel can invoke Square revenue sync with GET", () => {
    assert.equal(typeof squareRevenueCron.GET, "function");
    assert.equal(typeof squareRevenueCron.POST, "function");
  });

  test("customer directory cron targets an implemented integration route", () => {
    assert.equal(typeof squareCustomerDirectoryCron.GET, "function");
    assert.equal(typeof squareCustomerDirectoryCron.POST, "function");
    assert.equal(typeof legacySquareCron.GET, "function");
    assert.equal(typeof squareCustomerDirectoryIntegration.POST, "function");
  });
});
