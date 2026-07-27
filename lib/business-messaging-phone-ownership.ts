/**
 * Multi-tenant guard for `business_messaging_numbers`.
 * Phone numbers are globally unique (`onConflict: "phone_number"`), so a PUT
 * that upserts another workspace's E.164 would rewrite `business_id` and steal
 * inbound SMS routing.
 */

export type MessagingPhoneOwnershipDecision =
  | { ok: true; action: "insert" | "upsert_own" }
  | {
      ok: false;
      reason: "owned_by_other_business";
      ownerBusinessId: string;
    };

export function evaluateMessagingPhoneOwnership(input: {
  requestingBusinessId: string;
  existingOwnerBusinessId: string | null | undefined;
}): MessagingPhoneOwnershipDecision {
  const requesting = input.requestingBusinessId.trim();
  const existing =
    typeof input.existingOwnerBusinessId === "string" ?
      input.existingOwnerBusinessId.trim()
    : "";

  if (!requesting) {
    return {
      ok: false,
      reason: "owned_by_other_business",
      ownerBusinessId: existing || "unknown",
    };
  }

  if (!existing) {
    return { ok: true, action: "insert" };
  }

  if (existing === requesting) {
    return { ok: true, action: "upsert_own" };
  }

  return {
    ok: false,
    reason: "owned_by_other_business",
    ownerBusinessId: existing,
  };
}
