import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateMessagingPhoneOwnership } from "@/lib/business-messaging-phone-ownership";

describe("evaluateMessagingPhoneOwnership", () => {
  test("allows insert when no existing owner", () => {
    const decision = evaluateMessagingPhoneOwnership({
      requestingBusinessId: "biz-a",
      existingOwnerBusinessId: null,
    });
    assert.deepEqual(decision, { ok: true, action: "insert" });
  });

  test("allows upsert when the same business already owns the number", () => {
    const decision = evaluateMessagingPhoneOwnership({
      requestingBusinessId: "biz-a",
      existingOwnerBusinessId: "biz-a",
    });
    assert.deepEqual(decision, { ok: true, action: "upsert_own" });
  });

  test("rejects when another business already owns the number", () => {
    const decision = evaluateMessagingPhoneOwnership({
      requestingBusinessId: "biz-attacker",
      existingOwnerBusinessId: "biz-victim",
    });
    assert.deepEqual(decision, {
      ok: false,
      reason: "owned_by_other_business",
      ownerBusinessId: "biz-victim",
    });
  });

  test("trims ids before comparing", () => {
    const decision = evaluateMessagingPhoneOwnership({
      requestingBusinessId: "  biz-a  ",
      existingOwnerBusinessId: "biz-a",
    });
    assert.deepEqual(decision, { ok: true, action: "upsert_own" });
  });
});
