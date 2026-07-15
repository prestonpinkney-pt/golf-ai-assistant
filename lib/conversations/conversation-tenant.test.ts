import assert from "node:assert/strict";
import test from "node:test";
import { conversationAccessibleToBusiness } from "./conversation-tenant";

test("allows a conversation owned by the signed-in business", () => {
  assert.equal(
    conversationAccessibleToBusiness(
      { business_id: "business-a" },
      "business-a"
    ),
    true
  );
});

test("denies conversations owned by another business", () => {
  assert.equal(
    conversationAccessibleToBusiness(
      { business_id: "business-b" },
      "business-a"
    ),
    false
  );
});

test("fails closed for null or missing conversation ownership", () => {
  assert.equal(
    conversationAccessibleToBusiness({ business_id: null }, "business-a"),
    false
  );
  assert.equal(conversationAccessibleToBusiness({}, "business-a"), false);
});
