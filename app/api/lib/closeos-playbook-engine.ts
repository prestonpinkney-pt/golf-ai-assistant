import type { OutboundOpportunityTarget } from "./opportunity-eligible-targets";
import { sourceTier } from "./opportunity-target-ranking";

export type PlaybookTargetPreview = {
  id: string;
  leadName: string;
  recommendedOffer: string;
  opportunitySource: string | null;
};

export type CloseOsPlaybookSummary = {
  id: string;
  campaignName: string;
  sourceMix: Record<string, number>;
  opportunityTypes: string[];
  targetCount: number;
  estimatedRevenueCents: number;
  averageConfidence: number;
  averagePriority: number;
  recommendedChannel: string;
  recommendedAction: string;
  strategicReason: string;
  urgency: string;
  targetsPreview: PlaybookTargetPreview[];
  launchSafetyStatus: "manual_review_required";
};

/** Stable slug for URLs; matches playbook `id` in GET /api/opportunities/playbooks. */
export function slugifyCampaignName(name: string) {
  const s = (name ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "playbook";
}

export function filterTargetsByCampaignSlug(
  targets: OutboundOpportunityTarget[],
  campaignSlug: string,
  queryCampaignName?: string | null
): OutboundOpportunityTarget[] {
  const normalizedSlug = decodeURIComponent(campaignSlug).trim().toLowerCase();

  let out = targets.filter((t) => {
    const c = (t.recommendedCampaign || "Other").trim();
    return slugifyCampaignName(c) === normalizedSlug;
  });

  if (out.length === 0 && queryCampaignName?.trim()) {
    const q = queryCampaignName.trim();
    out = targets.filter((t) => (t.recommendedCampaign || "").trim() === q);
  }

  return out;
}

export type PlaybookTargetsSummary = {
  campaignName: string;
  campaignSlug: string;
  targetCount: number;
  estimatedRevenueCents: number;
  averageConfidence: number;
  averagePriority: number;
  recommendedChannel: string;
  recommendedAction: string;
  strategicReason: string;
  urgency: string;
  launchSafetyStatus: "manual_review_required";
};

export function summarizePlaybookFromTargets(
  filtered: OutboundOpportunityTarget[],
  campaignSlug: string,
  fallbackCampaignName?: string | null
): PlaybookTargetsSummary {
  const campaignName =
    filtered[0]?.recommendedCampaign?.trim() ||
    fallbackCampaignName?.trim() ||
    humanizeCampaignSlug(campaignSlug);

  const n = filtered.length;
  let revenue = 0;
  let confSum = 0;
  let priSum = 0;
  for (const t of filtered) {
    revenue += t.estimatedRevenueCents;
    confSum += t.confidence;
    priSum += t.targetScore;
  }

  const pbScore = playbookUrgencyScore(filtered);
  const channel = aggregateChannel(filtered);

  return {
    campaignName,
    campaignSlug: slugifyCampaignName(campaignName),
    targetCount: n,
    estimatedRevenueCents: revenue,
    averageConfidence: n ? Math.round(confSum / n) : 0,
    averagePriority: n ? Math.round(priSum / n) : 0,
    recommendedChannel: channel,
    recommendedAction: buildRecommendedAction(campaignName, n, channel),
    strategicReason: strategicReasonForCampaign(campaignName),
    urgency: urgencyLabelFromScore(pbScore),
    launchSafetyStatus: "manual_review_required",
  };
}

function humanizeCampaignSlug(slug: string) {
  const s = decodeURIComponent(slug).trim();
  if (!s) return "Campaign";
  return s
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function strategicReasonForCampaign(campaignName: string): string {
  const c = campaignName.trim();
  const map: Record<string, string> = {
    "Cancelled Lesson Recovery":
      "These customers had cancelled lessons and no replacement booking found. Recovering them quickly is likely easier than acquiring new leads.",
    "Lesson Rebooking":
      "These customers already booked lessons and are past the rebooking window. The ask is simple: get them back on the calendar.",
    "Clinic-to-Lesson Conversion":
      "Clinic participants are warm to coaching. A private lesson offer can deepen results and lift average revenue per customer.",
    "Event Follow-Up":
      "Event hosts and participants are primed for repeat group bookings while the experience is still fresh.",
    "Lesson Lead Follow-Up":
      "Direct lesson interest from marketing is high-intent; fast, helpful follow-up converts better than delayed batch sends.",
    "Simulator Booking Follow-Up":
      "Simulator interest signals active golfers; pairing time with light coaching upsell improves utilization and revenue.",
    "Practice-to-Lesson Upsell":
      "These customers showed practice or simulator behavior. A lesson offer can turn usage into higher-value coaching revenue.",
    "Recent Buyer Follow-Up":
      "Recent spenders are easiest to re-engage with the right next visit; timing beats broad prospecting.",
    "Member Lesson Rebooking":
      "Members expect frictionless scheduling; proactive lesson nudges protect retention and lesson revenue.",
    "Booking Intelligence":
      "Calendar-backed signals reduce guesswork: you are acting on real bookings, not generic lists.",
    "Guest-to-Member Nurture":
      "Repeat guests are evaluating fit; a respectful membership conversation can convert without heavy discounting.",
    "Member Experience Check-In":
      "Already members—focus on utilization and satisfaction, not acquisition.",
    "Member Loyalty Touch":
      "Reinforce value and book the next visit; loyalty beats another acquisition pitch.",
    "Win-Back (Light Touch)":
      "Win-back works best as a polite re-entry offer, not pressure; small batches preserve brand trust.",
    "Clinic Follow-Up":
      "Clinic graduates need a clear next step; lesson or next clinic prevents drop-off.",
    "Event Rebooking":
      "Repeat events are efficient revenue; group leads compound when captured early.",
    "Reactivation Follow-Up":
      "Lapsed contacts need a simple reason to return; one clear offer outperforms a menu.",
    "General Lead Follow-Up":
      "Broad leads need one qualifying question first, then routing—speed and clarity beat volume.",
    "Clinic Interest Follow-Up":
      "Clinic demand is time-boxed by schedule; responding while interest is hot protects fill rate.",
    "Event Interest Follow-Up":
      "Event planning has deadlines; early coordination wins larger bookings.",
    "Junior Program Follow-Up":
      "Junior decisions involve parents; respectful, concise follow-up builds trust fast.",
    "Membership Interest Follow-Up":
      "Membership conversations need human nuance—automate preparation, not promises.",
    "Purchase Signal":
      "Purchase history proves wallet engagement; the next offer should match how they already spend.",
    "Identity Review":
      "Resolve who the customer is before outreach to protect trust and compliance.",
    "Contact data completion":
      "Without a reachable channel, campaigns stall—enrich data before scaling sends.",
  };
  return (
    map[c] ??
    `${c}: group similar opportunities for one coordinated manual outbound push. Review each contact before any send.`
  );
}

/** Higher = more urgent (for sort). */
function targetUrgencyScore(t: OutboundOpportunityTarget): number {
  const ro = t.recognizedOpportunity;
  const d = t.daysSinceBooking;

  if (ro === "booking_cancelled_recovery") return 100;

  if (ro === "lesson_rebooking_due") {
    if (d != null && d >= 21 && d <= 60) return 85;
    if (d != null && d > 60) return 78;
    return 72;
  }

  if (ro === "event_follow_up") {
    if (d != null && d >= 0 && d <= 14) return 82;
    return 68;
  }

  if (ro.startsWith("mailchimp_")) return 68;

  if (ro === "recent_buyer_follow_up") return 55;

  if (ro === "inactive_customer_reactivation") {
    const highValue = t.totalSpendCents >= 50_000;
    if (d != null && d > 90 && !highValue) return 35;
    if (d != null && d > 90 && highValue) return 48;
    return 52;
  }

  if (ro === "practice_to_lesson") return 62;

  if (t.opportunitySource === "google_calendar_booking") return 70;

  return 50;
}

function urgencyLabelFromScore(score: number): string {
  if (score >= 95) return "urgent";
  if (score >= 78) return "high";
  if (score >= 62) return "medium-high";
  if (score >= 48) return "medium";
  return "lower";
}

function aggregateChannel(targets: OutboundOpportunityTarget[]): string {
  if (targets.length === 0) return "review_only";
  const channels = new Set(targets.map((t) => t.recommendedChannel));
  if (channels.has("sms")) return "sms";
  if (channels.size === 1 && channels.has("review_only")) return "review_only";
  if (channels.has("email")) return "email";
  return "sms";
}

function playbookUrgencyScore(targets: OutboundOpportunityTarget[]): number {
  if (targets.length === 0) return 0;
  return Math.max(...targets.map(targetUrgencyScore));
}

/** Source quality: lower tier = better (google=0). Sort helper uses negative. */
function playbookSourceQualityScore(targets: OutboundOpportunityTarget[]): number {
  if (targets.length === 0) return 99;
  return Math.min(...targets.map((t) => sourceTier(t.opportunitySource)));
}

function buildRecommendedAction(
  campaignName: string,
  count: number,
  channel: string
): string {
  if (channel === "review_only") {
    return `Manual review: resolve ${count} contact(s) in “${campaignName}” before any outreach.`;
  }
  return `Manual review: prepare personalized ${channel.toUpperCase()} drafts for ${count} contact(s) in “${campaignName}”. Do not auto-send.`;
}

export function buildPlaybooksFromTargets(
  targets: OutboundOpportunityTarget[]
): CloseOsPlaybookSummary[] {
  const byCampaign = new Map<string, OutboundOpportunityTarget[]>();
  for (const t of targets) {
    const key = (t.recommendedCampaign || "Other").trim() || "Other";
    const list = byCampaign.get(key) ?? [];
    list.push(t);
    byCampaign.set(key, list);
  }

  const playbooks: CloseOsPlaybookSummary[] = [];

  for (const [campaignName, group] of byCampaign) {
    const sourceMix: Record<string, number> = {};
    const typeSet = new Set<string>();
    let revenue = 0;
    let confSum = 0;
    let priSum = 0;

    for (const t of group) {
      sourceMix[t.sourceDisplayLabel] = (sourceMix[t.sourceDisplayLabel] ?? 0) + 1;
      typeSet.add(t.opportunityType || "unknown");
      revenue += t.estimatedRevenueCents;
      confSum += t.confidence;
      priSum += t.targetScore;
    }

    const n = group.length;
    const pbScore = playbookUrgencyScore(group);
    const channel = aggregateChannel(group);

    playbooks.push({
      id: slugifyCampaignName(campaignName),
      campaignName,
      sourceMix,
      opportunityTypes: [...typeSet].sort(),
      targetCount: n,
      estimatedRevenueCents: revenue,
      averageConfidence: n ? Math.round(confSum / n) : 0,
      averagePriority: n ? Math.round(priSum / n) : 0,
      recommendedChannel: channel,
      recommendedAction: buildRecommendedAction(campaignName, n, channel),
      strategicReason: strategicReasonForCampaign(campaignName),
      urgency: urgencyLabelFromScore(pbScore),
      targetsPreview: group.slice(0, 5).map((t) => ({
        id: t.id,
        leadName: t.leadName,
        recommendedOffer: t.recommendedOffer,
        opportunitySource: t.opportunitySource,
      })),
      launchSafetyStatus: "manual_review_required",
    });
  }

  playbooks.sort((a, b) => {
    const score = (p: CloseOsPlaybookSummary) => {
      const targetsInPlaybook = byCampaign.get(p.campaignName) ?? [];
      const u = playbookUrgencyScore(targetsInPlaybook);
      const rev = p.estimatedRevenueCents;
      const conf = p.averageConfidence;
      const cnt = p.targetCount;
      const src = playbookSourceQualityScore(targetsInPlaybook);
      return (
        u * 1e12 +
        rev * 1e6 +
        conf * 1e4 +
        cnt * 1e2 +
        (10 - src) * 1e1
      );
    };
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.campaignName.localeCompare(b.campaignName);
  });

  return playbooks;
}
