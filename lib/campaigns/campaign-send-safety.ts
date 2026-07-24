/**
 * Fail-closed helpers for campaign outbound send.
 * Contact lookup errors must block sends (opt-out/cooling-off cannot be verified).
 * Conversation attachment must be scoped to the sending business.
 */

export type CampaignContactRow = {
  id: string;
  name?: string | null;
  phone?: string | null;
  sms_opt_out?: boolean | null;
  cooling_off_until?: string | null;
};

export type CampaignContactLookupResult =
  | { ok: true; contact: CampaignContactRow | null }
  | { ok: false; reason: "contact_lookup_failed"; detail: string };

export function interpretCampaignContactLookup(input: {
  data: CampaignContactRow | null;
  error: { message?: string } | null;
}): CampaignContactLookupResult {
  if (input.error) {
    return {
      ok: false,
      reason: "contact_lookup_failed",
      detail: input.error.message?.trim() || "Contact lookup failed",
    };
  }
  return { ok: true, contact: input.data };
}

/**
 * Returns the filters that must be applied when attaching a campaign send
 * to an existing conversation. Omitting `business_id` can attach outbound
 * SMS to another tenant's thread when contacts are shared by phone.
 */
export function campaignConversationAttachmentFilters(input: {
  contactId: string;
  businessId: string;
}): { contact_id: string; business_id: string } {
  return {
    contact_id: input.contactId,
    business_id: input.businessId,
  };
}
