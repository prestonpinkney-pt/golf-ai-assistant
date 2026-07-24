import assert from "node:assert/strict";
import test from "node:test";
import { resolveOutboundSmsConsentGate } from "./outbound-sms-consent";

test("outbound SMS consent gate fails closed on contact lookup error", () => {
  const result = resolveOutboundSmsConsentGate({
    contact: null,
    lookupError: { message: "db unavailable" },
  });
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.equal(result.status, 503);
  }
});

test("outbound SMS consent gate blocks opted-out contacts", () => {
  const result = resolveOutboundSmsConsentGate({
    contact: { sms_opt_out: true, cooling_off_until: null },
    lookupError: null,
  });
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.equal(result.status, 403);
    assert.match(result.error, /opted out/i);
  }
});

test("outbound SMS consent gate blocks cooling-off contacts", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const result = resolveOutboundSmsConsentGate({
    contact: { sms_opt_out: false, cooling_off_until: future },
    lookupError: null,
  });
  assert.equal(result.allowed, false);
  if (!result.allowed) {
    assert.equal(result.status, 403);
    assert.match(result.error, /cooling-off/i);
  }
});

test("outbound SMS consent gate allows unknown numbers when lookup succeeds", () => {
  const result = resolveOutboundSmsConsentGate({
    contact: null,
    lookupError: null,
  });
  assert.equal(result.allowed, true);
});
