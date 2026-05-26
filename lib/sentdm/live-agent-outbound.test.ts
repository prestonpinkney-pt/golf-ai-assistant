import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  computeInboundProviderSendDecision,
  isLiveAgentTestMode,
  isPhoneOnLiveAgentAllowlist,
  resolveInboundProviderSendBlocker,
} from "./live-agent-outbound";

declare global {
  // eslint-disable-next-line no-var
  var __closeosLiveAgentSendAttempts:
    | Array<{ to: string; message: string }>
    | undefined;
}

const ALLOWLIST_PHONE = "+15103756639";
const OTHER_PHONE = "+15551112222";

const baseInput = {
  phone: ALLOWLIST_PHONE,
  contact: {
    id: "contact-1",
    sms_opt_out: false,
    cooling_off_until: null,
  },
  conversation: {
    automation_enabled: true,
    human_takeover: false,
  },
  autoSendEnabled: true,
  modelShouldSend: true,
  deferOutboundSms: false,
  escalationHuman: false,
  riskLevel: "low",
  shouldEscalate: false,
};

describe("live agent outbound policy", () => {
  const prevEnv = { ...process.env };

  afterEach(() => {
    Object.assign(process.env, prevEnv);
  });

  test("allowlisted live agent reply sends when model and policy pass", async () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = ALLOWLIST_PHONE;
    process.env.CLOSEOS_QUIET_HOURS_ENABLED = "false";
    process.env.SENTDM_API_KEY = "test-key";
    process.env.SENTDM_SEND_MODE = "direct_text";

    const mockSupabase = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          gte() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
    };

    const decision = await computeInboundProviderSendDecision(
      mockSupabase as never,
      baseInput
    );

    assert.equal(decision.allowProviderSend, true);
    assert.equal(decision.blocker, null);
    assert.equal(decision.allowlistPassed, true);
  });

  test("non-allowlisted number does not send in live agent test mode", () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = ALLOWLIST_PHONE;

    const blocker = resolveInboundProviderSendBlocker({
      ...baseInput,
      phone: OTHER_PHONE,
      maySendViaProvider: true,
      policyReasonCodes: [],
    });

    assert.equal(blocker, "not_allowlisted");
    assert.equal(isPhoneOnLiveAgentAllowlist(OTHER_PHONE), false);
  });

  test("STOP path still opts out before provider send decision", () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = ALLOWLIST_PHONE;

    const blocker = resolveInboundProviderSendBlocker({
      ...baseInput,
      contact: { ...baseInput.contact, sms_opt_out: true },
      maySendViaProvider: true,
      policyReasonCodes: [],
    });

    assert.equal(blocker, "sms_opt_out");
  });

  test("cooling-off still blocks allowlisted live agent send", () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = ALLOWLIST_PHONE;

    const blocker = resolveInboundProviderSendBlocker({
      ...baseInput,
      contact: {
        ...baseInput.contact,
        cooling_off_until: new Date(Date.now() + 86400000).toISOString(),
      },
      maySendViaProvider: true,
      policyReasonCodes: [],
    });

    assert.equal(blocker, "cooling_off");
  });

  test("refund/complaint still escalates via high_stakes_or_sensitive", () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = ALLOWLIST_PHONE;

    const blocker = resolveInboundProviderSendBlocker({
      ...baseInput,
      escalationHuman: true,
      riskLevel: "high",
      shouldEscalate: true,
      maySendViaProvider: false,
      policyReasonCodes: ["high_stakes_or_sensitive"],
    });

    assert.equal(blocker, "high_stakes_or_sensitive");
  });

  test("human_takeover blocks unless manually cleared", () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = ALLOWLIST_PHONE;

    const blocker = resolveInboundProviderSendBlocker({
      ...baseInput,
      conversation: { automation_enabled: true, human_takeover: true },
      maySendViaProvider: false,
      policyReasonCodes: ["human_takeover"],
    });

    assert.equal(blocker, "human_takeover");
  });

  test("quiet hours visible in debug decision output", async () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    process.env.CLOSEOS_TEST_SMS_ALLOWLIST = ALLOWLIST_PHONE;
    process.env.CLOSEOS_QUIET_HOURS_ENABLED = "true";
    process.env.CLOSEOS_QUIET_HOURS_START = "00:00";
    process.env.CLOSEOS_QUIET_HOURS_END = "23:59";
    process.env.SENTDM_API_KEY = "test-key";
    process.env.SENTDM_SEND_MODE = "direct_text";

    const mockSupabase = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          gte() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
    };

    const decision = await computeInboundProviderSendDecision(
      mockSupabase as never,
      baseInput
    );

    assert.equal(decision.quietHoursActive, true);
    assert.equal(decision.blocker, "quiet_hours");
  });

  test("isLiveAgentTestMode reads env flag", () => {
    process.env.CLOSEOS_LIVE_AGENT_TEST_MODE = "true";
    assert.equal(isLiveAgentTestMode(), true);
    delete process.env.CLOSEOS_LIVE_AGENT_TEST_MODE;
    assert.equal(isLiveAgentTestMode(), false);
  });
});
