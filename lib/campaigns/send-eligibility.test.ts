import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateCampaignSendWindow,
  evaluateCampaignTestAllowlist,
  evaluateLiveOutboundPolicy,
  isLikelyE164Phone,
  parseTestSmsAllowlist,
} from "./send-eligibility";

test("isLikelyE164Phone accepts US E.164", () => {
  assert.equal(isLikelyE164Phone("+15551234567"), true);
  assert.equal(isLikelyE164Phone("5551234567"), false);
});

test("parseTestSmsAllowlist splits env list", () => {
  const prev = process.env.CLOSEOS_TEST_SMS_ALLOWLIST;
  process.env.CLOSEOS_TEST_SMS_ALLOWLIST = "+15551111111, +15552222222";
  try {
    const set = parseTestSmsAllowlist();
    assert.equal(set.size, 2);
    assert.equal(set.has("+15551111111"), true);
  } finally {
    if (prev === undefined) delete process.env.CLOSEOS_TEST_SMS_ALLOWLIST;
    else process.env.CLOSEOS_TEST_SMS_ALLOWLIST = prev;
  }
});

test("evaluateCampaignTestAllowlist blocks when env set and phone missing", () => {
  const prev = process.env.CLOSEOS_TEST_SMS_ALLOWLIST;
  process.env.CLOSEOS_TEST_SMS_ALLOWLIST = "+15559998888";
  try {
    const blocked = evaluateCampaignTestAllowlist("+15551234567");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, "test_allowlist");

    const ok = evaluateCampaignTestAllowlist("+15559998888");
    assert.equal(ok.allowed, true);
  } finally {
    if (prev === undefined) delete process.env.CLOSEOS_TEST_SMS_ALLOWLIST;
    else process.env.CLOSEOS_TEST_SMS_ALLOWLIST = prev;
  }
});

test("evaluateCampaignTestAllowlist passes when env unset", () => {
  const prev = process.env.CLOSEOS_TEST_SMS_ALLOWLIST;
  delete process.env.CLOSEOS_TEST_SMS_ALLOWLIST;
  try {
    const result = evaluateCampaignTestAllowlist("+15551234567");
    assert.equal(result.allowed, true);
  } finally {
    if (prev === undefined) delete process.env.CLOSEOS_TEST_SMS_ALLOWLIST;
    else process.env.CLOSEOS_TEST_SMS_ALLOWLIST = prev;
  }
});

test("evaluateCampaignSendWindow respects quiet hours flag", () => {
  const prevEnabled = process.env.CLOSEOS_QUIET_HOURS_ENABLED;
  const prevStart = process.env.CLOSEOS_QUIET_HOURS_START;
  const prevEnd = process.env.CLOSEOS_QUIET_HOURS_END;
  const prevTz = process.env.CLOSEOS_QUIET_HOURS_TIMEZONE;

  process.env.CLOSEOS_QUIET_HOURS_ENABLED = "false";
  assert.equal(evaluateCampaignSendWindow().allowed, true);

  process.env.CLOSEOS_QUIET_HOURS_ENABLED = "true";
  process.env.CLOSEOS_QUIET_HOURS_TIMEZONE = "UTC";
  process.env.CLOSEOS_QUIET_HOURS_START = "00:00";
  process.env.CLOSEOS_QUIET_HOURS_END = "23:59";
  assert.equal(evaluateCampaignSendWindow().allowed, false);

  if (prevEnabled === undefined) delete process.env.CLOSEOS_QUIET_HOURS_ENABLED;
  else process.env.CLOSEOS_QUIET_HOURS_ENABLED = prevEnabled;
  if (prevStart === undefined) delete process.env.CLOSEOS_QUIET_HOURS_START;
  else process.env.CLOSEOS_QUIET_HOURS_START = prevStart;
  if (prevEnd === undefined) delete process.env.CLOSEOS_QUIET_HOURS_END;
  else process.env.CLOSEOS_QUIET_HOURS_END = prevEnd;
  if (prevTz === undefined) delete process.env.CLOSEOS_QUIET_HOURS_TIMEZONE;
  else process.env.CLOSEOS_QUIET_HOURS_TIMEZONE = prevTz;
});

test("evaluateLiveOutboundPolicy blocks unattended send when auto-send disabled", () => {
  const result = evaluateLiveOutboundPolicy({
    smsOptOut: false,
    humanTakeover: false,
    automationDisabled: false,
    highStakesOrSensitive: false,
    autoSendEnabled: false,
    messageGoal: "inbound_reply",
    lastOutboundAtMs: null,
    outboundCount24h: 0,
  });
  assert.equal(result.maySendViaProvider, false);
  assert.equal(result.decision.mode, "recommend_approval");
});

test("evaluateLiveOutboundPolicy allows unattended send when policy gates pass", () => {
  const result = evaluateLiveOutboundPolicy({
    smsOptOut: false,
    humanTakeover: false,
    automationDisabled: false,
    highStakesOrSensitive: false,
    autoSendEnabled: true,
    messageGoal: "inbound_reply",
    lastOutboundAtMs: null,
    outboundCount24h: 0,
  });
  assert.equal(result.maySendViaProvider, true);
  assert.equal(result.decision.mode, "allowed_auto_send");
});

test("evaluateLiveOutboundPolicy blocks human takeover threads", () => {
  const result = evaluateLiveOutboundPolicy({
    smsOptOut: false,
    humanTakeover: true,
    automationDisabled: false,
    highStakesOrSensitive: false,
    autoSendEnabled: true,
    messageGoal: "inbound_reply",
    lastOutboundAtMs: null,
    outboundCount24h: 0,
  });
  assert.equal(result.maySendViaProvider, false);
  assert.ok(result.decision.reasonCodes.includes("human_takeover"));
});

test("evaluateLiveOutboundPolicy blocks contact cooling-off period", () => {
  const result = evaluateLiveOutboundPolicy({
    smsOptOut: false,
    contactCoolingOff: true,
    humanTakeover: false,
    automationDisabled: false,
    highStakesOrSensitive: false,
    autoSendEnabled: true,
    messageGoal: "inbound_reply",
    lastOutboundAtMs: null,
    outboundCount24h: 0,
  });
  assert.equal(result.maySendViaProvider, false);
  assert.ok(result.decision.reasonCodes.includes("contact_cooling_off"));
});
