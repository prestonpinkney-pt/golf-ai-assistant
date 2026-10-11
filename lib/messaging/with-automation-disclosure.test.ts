import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import { withAutomationDisclosure } from "@/lib/messaging/with-automation-disclosure";

const base = {
  replyText: "We do lessons and sim time — what were you thinking?",
  assistantName: "Front desk",
  businessName: "Primetime Golf",
  shouldDiscloseAutomation: true,
};

describe("withAutomationDisclosure", () => {
  afterEach(() => {
    delete process.env.CLOSEOS_AUTOMATION_DISCLOSURE;
  });

  test("minimal mode avoids automated-assistant wording", () => {
    process.env.CLOSEOS_AUTOMATION_DISCLOSURE = "minimal";
    const out = withAutomationDisclosure(base);
    assert.match(out, /^Hi — Front desk at Primetime Golf\./);
    assert.doesNotMatch(out, /automated assistant/i);
    assert.match(out, /We do lessons/);
  });

  test("full mode keeps legacy automated-assistant line", () => {
    process.env.CLOSEOS_AUTOMATION_DISCLOSURE = "full";
    const out = withAutomationDisclosure(base);
    assert.match(out, /automated assistant for Primetime Golf/);
  });

  test("off mode returns body only", () => {
    process.env.CLOSEOS_AUTOMATION_DISCLOSURE = "off";
    const out = withAutomationDisclosure(base);
    assert.equal(out, base.replyText);
  });
});
