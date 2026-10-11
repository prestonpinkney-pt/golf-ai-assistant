import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  extractLessonDurationFromCustomerLine,
  extractLessonDurationFromCustomerText,
  outboundLooksLikePendingTeamHandoff,
} from "@/lib/ai/sms-booking-flow";

describe("lesson duration parsing (customer-only)", () => {
  test("does not treat 11:30 AM slot copy as 30-minute lesson", () => {
    const botOffer =
      "Thu Jun 4: I see 11:00 AM-11:30 AM, 11:15 AM-11:45 AM and 11:30 AM-12:00 PM available.";
    assert.equal(extractLessonDurationFromCustomerText(botOffer), null);
  });

  test("full hour on latest customer line wins over earlier 30 in thread", () => {
    const customer = [
      "Adult",
      "30 min",
      "These are all 30 mins I want an hour",
      "I want a full hour",
    ].join("\n");
    assert.equal(extractLessonDurationFromCustomerText(customer), 60);
  });

  test("extractLessonDurationFromCustomerLine recognizes full hour", () => {
    assert.equal(extractLessonDurationFromCustomerLine("Full hour"), 60);
    assert.equal(extractLessonDurationFromCustomerLine("I want a full hour"), 60);
  });
});

describe("post-handoff detection", () => {
  test("recognizes team confirmation handoff copy", () => {
    assert.equal(
      outboundLooksLikePendingTeamHandoff(
        "I've got your details saved — someone on the team will text you shortly to finish locking this in."
      ),
      true
    );
  });
});
