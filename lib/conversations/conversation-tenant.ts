/**
 * Service-role-backed dashboard routes must fail closed when tenant ownership is
 * absent. Allowing legacy null rows would expose them to every workspace.
 */
export function conversationAccessibleToBusiness(
  conversation: { business_id?: string | null },
  businessId: string
): boolean {
  const rowBiz = conversation.business_id ?? null;
  return rowBiz != null && rowBiz === businessId;
}
