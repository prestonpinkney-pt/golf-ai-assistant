import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { resolveBusinessMessagingConfig } from "@/lib/business-messaging-config";

describe("resolveBusinessMessagingConfig tenant routing", () => {
  const savedBusinessesJson = process.env.CLOSEOS_BUSINESSES_JSON;

  afterEach(() => {
    if (savedBusinessesJson === undefined) delete process.env.CLOSEOS_BUSINESSES_JSON;
    else process.env.CLOSEOS_BUSINESSES_JSON = savedBusinessesJson;
  });

  test("destination phone wins over mismatched payload business_id", () => {
    process.env.CLOSEOS_BUSINESSES_JSON = JSON.stringify([
      {
        id: "biz-a",
        slug: "alpha",
        name: "Alpha Golf",
        smsFromNumber: "+15551110001",
        inboundNumbers: ["+15551110001"],
        aiSourceOfTruth: "Alpha facts",
      },
      {
        id: "biz-b",
        slug: "bravo",
        name: "Bravo Golf",
        smsFromNumber: "+15552220002",
        inboundNumbers: ["+15552220002"],
        aiSourceOfTruth: "Bravo facts",
      },
    ]);

    const config = resolveBusinessMessagingConfig({
      businessId: "biz-a",
      toNumber: "+15552220002",
    });

    assert.equal(config.id, "biz-b");
    assert.equal(config.slug, "bravo");
  });

  test("payload business_id is used when no destination phone is provided", () => {
    process.env.CLOSEOS_BUSINESSES_JSON = JSON.stringify([
      {
        id: "biz-a",
        slug: "alpha",
        name: "Alpha Golf",
        smsFromNumber: "+15551110001",
        aiSourceOfTruth: "Alpha facts",
      },
      {
        id: "biz-b",
        slug: "bravo",
        name: "Bravo Golf",
        smsFromNumber: "+15552220002",
        aiSourceOfTruth: "Bravo facts",
      },
    ]);

    const config = resolveBusinessMessagingConfig({
      businessId: "biz-a",
    });

    assert.equal(config.id, "biz-a");
  });
});
