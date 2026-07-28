import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { outboundLinkedToInboundMessage } from "./inbound-external-id-dedupe";

describe("outboundLinkedToInboundMessage", () => {
  test("returns false when no outbound rows exist", () => {
    assert.equal(
      outboundLinkedToInboundMessage({
        inboundMessageId: "in-1",
        outboundMessages: [],
      }),
      false
    );
  });

  test("returns false when outbound metadata lacks inbound_message_id", () => {
    assert.equal(
      outboundLinkedToInboundMessage({
        inboundMessageId: "in-1",
        outboundMessages: [{ metadata: { business_id: "b1" } }],
      }),
      false
    );
  });

  test("returns false when outbound links a different inbound", () => {
    assert.equal(
      outboundLinkedToInboundMessage({
        inboundMessageId: "in-1",
        outboundMessages: [{ metadata: { inbound_message_id: "in-other" } }],
      }),
      false
    );
  });

  test("returns true when an outbound links this inbound", () => {
    assert.equal(
      outboundLinkedToInboundMessage({
        inboundMessageId: "in-1",
        outboundMessages: [
          { metadata: { inbound_message_id: "in-other" } },
          { metadata: { inbound_message_id: "in-1", intent: "stop" } },
        ],
      }),
      true
    );
  });

  test("ignores null/non-object metadata", () => {
    assert.equal(
      outboundLinkedToInboundMessage({
        inboundMessageId: "in-1",
        outboundMessages: [
          { metadata: null },
          { metadata: "x" },
          { metadata: ["in-1"] },
        ],
      }),
      false
    );
  });
});
