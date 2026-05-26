import type { OutboundOpportunityTarget } from "@/app/api/lib/opportunity-eligible-targets";
import { WHOOSH_SLOW_TIME_RECOGNIZED } from "@/lib/whoosh/types";

export type CampaignFocus =
  | "best"
  | "simulator"
  | "slow_time"
  | "lessons"
  | "memberships"
  | "events";

const WHOOSH_VERIFIED_RECOGNIZED = new Set<string>(WHOOSH_SLOW_TIME_RECOGNIZED);

const LESSON_RECOGNIZED = new Set([
  "lesson_rebooking_due",
  "practice_to_lesson",
  "lesson_package_candidate",
  "member_lesson_rebooking",
  "mailchimp_lesson_interest",
  "clinic_progression",
  "booking_cancelled_recovery",
]);

const MEMBERSHIP_RECOGNIZED = new Set([
  "membership_conversion_candidate",
  "repeat_guest_to_member",
  "member_reactivation",
]);

const EVENT_RECOGNIZED = new Set([
  "private_event_booking_candidate",
  "event_rebooking",
  "event_follow_up",
  "friday_scramble_invite",
  "open_house_invite",
]);

function whooshVerifiedRecognized(ro: string): boolean {
  return WHOOSH_VERIFIED_RECOGNIZED.has(ro);
}

export function isWhooshVerifiedTarget(t: OutboundOpportunityTarget): boolean {
  return (
    t.availabilityVerified === true &&
    (t.availabilitySource === "whoosh" || whooshVerifiedRecognized(t.recognizedOpportunity))
  );
}

export function filterTargetsByCampaignFocus(
  targets: OutboundOpportunityTarget[],
  focus: CampaignFocus
): OutboundOpportunityTarget[] {
  if (focus === "best") return targets;

  if (focus === "slow_time" || focus === "simulator") {
    return targets.filter(
      (t) =>
        isWhooshVerifiedTarget(t) &&
        WHOOSH_VERIFIED_RECOGNIZED.has(t.recognizedOpportunity)
    );
  }

  if (focus === "lessons") {
    return targets.filter((t) => LESSON_RECOGNIZED.has(t.recognizedOpportunity));
  }

  if (focus === "memberships") {
    return targets.filter((t) => MEMBERSHIP_RECOGNIZED.has(t.recognizedOpportunity));
  }

  if (focus === "events") {
    return targets.filter((t) => EVENT_RECOGNIZED.has(t.recognizedOpportunity));
  }

  return targets;
}

export function campaignFocusLabel(focus: CampaignFocus): string {
  switch (focus) {
    case "simulator":
      return "Fill Simulator Time";
    case "slow_time":
      return "Fill Slow Times";
    case "lessons":
      return "Lessons";
    case "memberships":
      return "Memberships";
    case "events":
      return "Events";
    default:
      return "CloseOS AI Campaign";
  }
}
