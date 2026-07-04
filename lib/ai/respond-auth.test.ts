import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { canCallerUseAiRespondForConversation } from "./respond-auth";

describe("ai/respond conversation authorization", () => {
  test("allows internal callers without a dashboard business context", () => {
    assert.equal(
      canCallerUseAiRespondForConversation({
        internalCaller: true,
        businessId: null,
        conversation: { business_id: "other-business" },
      }),
      true
    );
  });

  test("allows dashboard callers for their own business conversations", () => {
    assert.equal(
      canCallerUseAiRespondForConversation({
        internalCaller: false,
        businessId: "business-1",
        conversation: { business_id: "business-1" },
      }),
      true
    );
  });

  test("rejects dashboard callers for another business conversation", () => {
    assert.equal(
      canCallerUseAiRespondForConversation({
        internalCaller: false,
        businessId: "business-1",
        conversation: { business_id: "business-2" },
      }),
      false
    );
  });

  test("preserves legacy access for unscoped conversations", () => {
    assert.equal(
      canCallerUseAiRespondForConversation({
        internalCaller: false,
        businessId: "business-1",
        conversation: { business_id: null },
      }),
      true
    );
  });

  test("rejects non-internal callers without a verified business context", () => {
    assert.equal(
      canCallerUseAiRespondForConversation({
        internalCaller: false,
        businessId: null,
        conversation: { business_id: "business-1" },
      }),
      false
    );
  });
});
