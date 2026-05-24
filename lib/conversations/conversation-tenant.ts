/**
 * When `business_id` is set on a conversation, it must match the signed-in workspace.
 * Null means legacy row (pre-migration) — allow until backfill.
 */
export function conversationAccessibleToBusiness(
  conversation: { business_id?: string | null },
  businessId: string
): boolean {
  const rowBiz = conversation.business_id ?? null;
  if (rowBiz == null) return true;
  return rowBiz === businessId;
}
