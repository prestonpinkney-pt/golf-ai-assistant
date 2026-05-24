import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  evaluateCustomerInboundEligibility,
  textMatchesOurTemplateWrapperPrefix,
} from "./sentdm-inbound-eligibility";

const baseEnvelope = {
  payload: { inbound_number: "+15551234567" },
} as Record<string, unknown>;

describe("evaluateCustomerInboundEligibility", () => {
  test("allows INBOUND + RECEIVED with matching hinted phone", () => {
    const r = evaluateCustomerInboundEligibility(
      {
        direction: "INBOUND",
        statusRaw: "RECEIVED",
        from: "+15551234567",
        to: "+18005551212",
      },
      baseEnvelope
    );
    assert.equal(r.allow, true);
  });

  test("rejects OUTBOUND", () => {
    const r = evaluateCustomerInboundEligibility(
      {
        direction: "OUTBOUND",
        statusRaw: "DELIVERED",
        from: "+18005551212",
        to: "+15551234567",
      },
      baseEnvelope
    );
    assert.equal(r.allow, false);
    if (!r.allow) assert.equal(r.reason, "direction_outbound");
  });

  test("rejects INBOUND + DELIVERED (not RECEIVED)", () => {
    const r = evaluateCustomerInboundEligibility(
      {
        direction: "INBOUND",
        statusRaw: "DELIVERED",
        from: "+15551234567",
        to: "+18005551212",
      },
      baseEnvelope
    );
    assert.equal(r.allow, false);
    if (!r.allow) assert.match(r.reason, /^status_/);
  });

  test("rejects outbound-queued style lifecycle on non-received", () => {
    const r = evaluateCustomerInboundEligibility(
      {
        direction: "INBOUND",
        statusRaw: "QUEUED",
        from: "+15551234567",
        to: null,
      },
      baseEnvelope
    );
    assert.equal(r.allow, false);
  });

  test("rejects missing direction", () => {
    const r = evaluateCustomerInboundEligibility(
      {
        direction: null,
        statusRaw: "RECEIVED",
        from: "+15551234567",
        to: null,
      },
      baseEnvelope
    );
    assert.equal(r.allow, false);
    if (!r.allow) assert.equal(r.reason, "direction_missing");
  });

  test("rejects inbound_phone_mismatch when envelope hints customer number", () => {
    const r = evaluateCustomerInboundEligibility(
      {
        direction: "INBOUND",
        statusRaw: "RECEIVED",
        from: "+19999999999",
        to: "+18005551212",
      },
      baseEnvelope
    );
    assert.equal(r.allow, false);
    if (!r.allow) assert.equal(r.reason, "inbound_phone_mismatch");
  });
});

describe("textMatchesOurTemplateWrapperPrefix", () => {
  test("detects Primetime and Message prefixes", () => {
    assert.equal(
      textMatchesOurTemplateWrapperPrefix("Primetime: welcome"),
      true
    );
    assert.equal(textMatchesOurTemplateWrapperPrefix("Message: hi"), true);
    assert.equal(textMatchesOurTemplateWrapperPrefix("Hello there"), false);
  });
});
