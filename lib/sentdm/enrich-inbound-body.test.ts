import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { enrichSentDmInboundBody } from "./enrich-inbound-body";

const fixturesDir = join(process.cwd(), "tests/fixtures/sentdm");

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixturesDir, name), "utf8")
  ) as Record<string, unknown>;
}

describe("enrichSentDmInboundBody", () => {
  const savedFetch = globalThis.fetch;
  const prevApiKey = process.env.SENTDM_API_KEY;

  afterEach(() => {
    globalThis.fetch = savedFetch;
    if (prevApiKey === undefined) delete process.env.SENTDM_API_KEY;
    else process.env.SENTDM_API_KEY = prevApiKey;
  });

  test("text-only inbound accepts envelope without lookup (expected local test)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("should_not_fetch");
    };

    const body = loadFixture("inbound-text-only.local.json");
    const result = await enrichSentDmInboundBody(body);

    assert.equal(result.ok, true);
    assert.equal(fetchCalls, 0);
    if (result.ok) {
      assert.deepEqual(result.body, body);
    }
  });

  test("inbound with message_id attempts Sent.dm lookup", async () => {
    process.env.SENTDM_API_KEY = "test-key";
    let fetchUrl = "";
    globalThis.fetch = async (input: RequestInfo | URL) => {
      fetchUrl = String(input);
      return new Response(
        JSON.stringify({
          data: {
            id: "sdm-msg-prod-like-001",
            direction: "INBOUND",
            status: "RECEIVED",
            from: "+15551234567",
            to: "+15559876543",
            text: "Lookup body text",
            channel: "sms",
          },
        }),
        { status: 200 }
      );
    };

    const body = loadFixture("inbound-with-message-id.json");
    const result = await enrichSentDmInboundBody(body);

    assert.match(fetchUrl, /sdm-msg-prod-like-001/);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.body.text, "Lookup body text");
    }
  });

  test("malformed no text and no id fails with missing_message_text_and_message_id", async () => {
    globalThis.fetch = async () => {
      throw new Error("should_not_fetch");
    };

    const body = loadFixture("malformed-no-text-no-id.json");
    const result = await enrichSentDmInboundBody(body);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal("error" in result, true);
    if ("error" in result) {
      assert.equal(result.error, "missing_message_text_and_message_id");
    }
  });
});
