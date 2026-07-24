import assert from "node:assert/strict";
import test from "node:test";
import {
  campaignConversationAttachmentFilters,
  interpretCampaignContactLookup,
} from "./campaign-send-safety";

test("interpretCampaignContactLookup fails closed on lookup error", () => {
  const result = interpretCampaignContactLookup({
    data: null,
    error: { message: "JSON object requested, multiple (or no) rows returned" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "contact_lookup_failed");
    assert.match(result.detail, /multiple|failed/i);
  }
});

test("interpretCampaignContactLookup allows missing contact when lookup succeeds", () => {
  const result = interpretCampaignContactLookup({
    data: null,
    error: null,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.contact, null);
  }
});

test("interpretCampaignContactLookup returns contact row on success", () => {
  const result = interpretCampaignContactLookup({
    data: {
      id: "contact-1",
      phone: "+15551234567",
      sms_opt_out: true,
    },
    error: null,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.contact?.id, "contact-1");
    assert.equal(result.contact?.sms_opt_out, true);
  }
});

test("campaignConversationAttachmentFilters always include business_id", () => {
  const filters = campaignConversationAttachmentFilters({
    contactId: "contact-1",
    businessId: "business-a",
  });
  assert.deepEqual(filters, {
    contact_id: "contact-1",
    business_id: "business-a",
  });
});
