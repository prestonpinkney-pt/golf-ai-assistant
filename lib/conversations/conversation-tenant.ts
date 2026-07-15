/**
 * Conversations without an explicit tenant cannot be safely exposed through
 * service-role-backed dashboard APIs. Legacy rows must be backfilled before
 * they become accessible.
 */
export function conversationAccessibleToBusiness(
  conversation: { business_id?: string | null },
  businessId: string
): boolean {
  const rowBiz = conversation.business_id ?? null;
  return rowBiz !== null && rowBiz === businessId;
}
