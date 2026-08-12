import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  findOutboundLinkedToInbound,
  linkedOutboundAlreadySent,
  linkedOutboundNeedsProviderResend,
  outboundLinksToInbound,
  readOutboundSmsBody,
} from "./inbound-outbound-link";

describe("inbound-outbound-link", () => {
  test("outboundLinksToInbound matches metadata.inbound_message_id", () => {
    assert.equal(
      outboundLinksToInbound(
        { id: "o1", metadata: { inbound_message_id: "in-1" } },
        "in-1"
      ),
      true
    );
    assert.equal(
      outboundLinksToInbound(
        { id: "o1", metadata: { inbound_message_id: "in-other" } },
        "in-1"
      ),
      false
    );
    assert.equal(
      outboundLinksToInbound({ id: "o1", metadata: {} }, "in-1"),
      false
    );
  });

  test("findOutboundLinkedToInbound returns first match", () => {
    const found = findOutboundLinkedToInbound(
      [
        { id: "a", metadata: { inbound_message_id: "other" } },
        { id: "b", metadata: { inbound_message_id: "in-1" }, status: "failed" },
      ],
      "in-1"
    );
    assert.equal(found?.id, "b");
  });

  test("failed/pending_send need resend; queued/sent do not", () => {
    assert.equal(
      linkedOutboundNeedsProviderResend({ id: "1", status: "failed" }),
      true
    );
    assert.equal(
      linkedOutboundNeedsProviderResend({
        id: "1",
        status: "pending_send",
        delivery_status: "not_sent",
      }),
      true
    );
    assert.equal(
      linkedOutboundNeedsProviderResend({ id: "1", status: "queued" }),
      false
    );
    assert.equal(
      linkedOutboundAlreadySent({ id: "1", status: "sent" }),
      true
    );
  });

  test("readOutboundSmsBody prefers message_text", () => {
    assert.equal(
      readOutboundSmsBody({
        id: "1",
        message_text: " hello ",
        body: "ignored",
      }),
      "hello"
    );
    assert.equal(
      readOutboundSmsBody({ id: "1", body: " from body " }),
      "from body"
    );
  });
});
