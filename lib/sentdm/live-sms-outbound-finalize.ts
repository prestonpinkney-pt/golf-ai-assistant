import { withAutomationDisclosure } from "@/lib/messaging/with-automation-disclosure";
import { applyBookingConfirmationOutboundGuard } from "@/lib/ai/booking-outbound-guard";

/** Disclosure (SMS-first-outbound parity) then Whoosh booking confirmation guard — RCS skips guard/disclosure tweaks. */
export function finalizeLiveSmsOutboundText(input: {
  draftReply: string;
  channel: "sms" | "rcs";
  businessName: string;
  assistantName: string;
  shouldDiscloseAutomation: boolean;
  bookingConfirmedByWhoosh: boolean;
}): {
  responseText: string;
  confirmationGuardBlocked: boolean;
  confirmationGuardMatched?: string;
} {
  const disclosed =
    input.channel !== "sms" ?
      input.draftReply
    : withAutomationDisclosure({
        replyText: input.draftReply,
        businessName: input.businessName,
        assistantName: input.assistantName,
        shouldDiscloseAutomation: input.shouldDiscloseAutomation,
      });

  if (input.channel !== "sms") {
    return {
      responseText: disclosed,
      confirmationGuardBlocked: false,
    };
  }

  const guarded = applyBookingConfirmationOutboundGuard({
    replyTextFull: disclosed,
    bookingConfirmedByWhoosh: input.bookingConfirmedByWhoosh,
  });
  return {
    responseText: guarded.replyTextFull,
    confirmationGuardBlocked: guarded.blocked,
    confirmationGuardMatched: guarded.matchedPattern,
  };
}
