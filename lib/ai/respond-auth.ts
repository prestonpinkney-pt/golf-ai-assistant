import { conversationAccessibleToBusiness } from "@/lib/conversations/conversation-tenant";

export function canCallerUseAiRespondForConversation(input: {
  internalCaller: boolean;
  businessId: string | null;
  conversation: { business_id?: string | null };
}): boolean {
  if (input.internalCaller) return true;
  if (!input.businessId) return false;
  return conversationAccessibleToBusiness(input.conversation, input.businessId);
}
