"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { buildWhyNowLine, oneSentence } from "@/lib/operator-ui-copy";

type PlaybookTargetRow = {
  id: string;
  opportunityId: string;
  targetingProfileId: string | null;
  customerProfileId: string;
  externalCustomerId: string;
  opportunitySource: string | null;
  sourceDisplayLabel: string;
  leadName: string;
  email: string | null;
  phone: string | null;
  isMember: boolean;
  totalSpendCents: number;
  visitCount: number;
  lastPurchaseAt: string | null;
  targetScore: number;
  confidence: number;
  opportunityType: string;
  estimatedRevenueCents: number;
  playbook: string;
  status: string;
  recommendedOffer: string;
  reason: string;
  recommendedMessage: string;
  recognizedOpportunity: string;
  opportunitySignalSummary: string;
  nextBestAction: string;
  replyHandlingGoal: string;
  recommendedCampaign: string;
  recommendedChannel: string;
  aiConfidenceReason: string;
  objectionHandlingNotes: string;
  followUpPlan: string;
  lastBookingAt: string | null;
  lastBookingType: string | null;
  bookingStatus: string | null;
  bookingTitle: string | null;
  daysSinceBooking: number | null;
};

type PlaybookTargetsApiResponse = {
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
  launchSafetyStatus: string;
  targets: PlaybookTargetRow[];
};

type FeedbackAction =
  | "good_target"
  | "wrong_offer"
  | "exclude"
  | "converted";

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function labelize(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function cleanDisplayMessage(message: string) {
  return message
    .replaceAll("Hi —", "Hi,")
    .replaceAll("Hi -", "Hi,")
    .replace(/\s+/g, " ")
    .trim();
}

function formatRecommendedChannel(channel: string | undefined) {
  if (!channel) return "SMS";
  if (channel === "review_only") return "Review only";
  if (channel === "sms") return "SMS (manual)";
  if (channel === "email") return "Email (manual)";
  return labelize(channel);
}

function sourceBadgeClass(label: string | undefined) {
  const l = (label ?? "").toLowerCase();
  if (l.includes("booking")) {
    return "border border-indigo-200 bg-indigo-50 text-indigo-900";
  }
  if (l.includes("mailchimp")) {
    return "border border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (l.includes("purchase")) {
    return "border border-slate-300 bg-slate-50 text-slate-700";
  }
  return "border border-slate-300 bg-slate-50 text-slate-700";
}

/** Urgency pills on dark navy header — solid fills for contrast */
function urgencyBadgeClass(urgency: string) {
  const u = urgency.toLowerCase();
  if (u === "urgent")
    return "border border-red-500 bg-red-600 text-white shadow-sm";
  if (u === "high")
    return "border border-amber-400 bg-amber-500 text-amber-950 shadow-sm";
  if (u === "medium-high")
    return "border border-amber-300 bg-amber-400 text-amber-950 shadow-sm";
  if (u === "medium")
    return "border border-sky-400 bg-sky-500 text-white shadow-sm";
  return "border border-slate-500 bg-slate-700 text-white shadow-sm";
}

const closeOsBtnSecondary =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900 no-underline shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const closeOsBtnPrimary =
  "inline-flex items-center justify-center rounded-lg border border-slate-900 bg-slate-900 px-3 py-2 text-xs font-semibold text-white no-underline shadow-sm transition hover:bg-slate-800";
const closeOsBtnSuccess =
  "inline-flex items-center justify-center rounded-lg border border-emerald-700 bg-emerald-600 px-3 py-2 text-xs font-semibold text-white no-underline shadow-sm transition hover:bg-emerald-700";

function targetFeedbackButtonClass(action: FeedbackAction): string {
  const base =
    "rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50";
  switch (action) {
    case "good_target":
    case "converted":
      return `${base} border-emerald-700 bg-emerald-600 text-white hover:bg-emerald-700`;
    case "wrong_offer":
      return `${base} border-amber-400 bg-amber-100 text-amber-950 hover:bg-amber-200`;
    case "exclude":
      return `${base} border-red-700 bg-red-600 text-white hover:bg-red-700`;
  }
}

function buildTargetOutboundHref(target: PlaybookTargetRow) {
  const params = new URLSearchParams({
    opportunity_id: target.id,
    playbook: target.playbook,
    contacts: "1",
    estimated_revenue: String(Math.round(target.estimatedRevenueCents / 100)),
    lead_name: target.leadName,
    lead_type: target.isMember ? "member" : "guest",
    opportunity_type: target.opportunityType,
  });
  return `/outbound?${params.toString()}`;
}

function buildDraftCampaignHref(summary: PlaybookTargetsApiResponse | null) {
  if (!summary) return "/outbound?manual_draft=1";
  const params = new URLSearchParams({
    playbook_campaign: summary.campaignName,
    manual_draft: "1",
    target_count: String(summary.targetCount),
  });
  return `/outbound?${params.toString()}`;
}

function getFeedbackNote(action: FeedbackAction, target: PlaybookTargetRow) {
  switch (action) {
    case "good_target":
      return `Operator confirmed ${target.leadName} is a good target (playbook review).`;
    case "wrong_offer":
      return `Operator said ${target.leadName} is valid but the offer is wrong.`;
    case "exclude":
      return `Operator excluded ${target.leadName} from AI targeting.`;
    case "converted":
      return `Operator marked ${target.leadName} as converted.`;
  }
}

function getFeedbackLabel(action: FeedbackAction) {
  switch (action) {
    case "good_target":
      return "Good Target";
    case "wrong_offer":
      return "Wrong Offer";
    case "exclude":
      return "Exclude";
    case "converted":
      return "Converted";
  }
}

function PlaybookCampaignReviewPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const campaignSlug = (params.campaign as string) ?? "";
  const campaignQuery = searchParams.get("campaign");

  const [data, setData] = useState<PlaybookTargetsApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedbackLoadingId, setFeedbackLoadingId] = useState<string | null>(
    null
  );
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const apiUrl = useMemo(() => {
    const q = campaignQuery
      ? `?campaign=${encodeURIComponent(campaignQuery)}`
      : "";
    return `/api/opportunities/playbooks/${encodeURIComponent(campaignSlug)}/targets${q}`;
  }, [campaignSlug, campaignQuery]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(apiUrl, { cache: "no-store" });
      const json = (await res.json()) as PlaybookTargetsApiResponse & {
        error?: string;
        details?: string;
      };
      if (!res.ok) {
        throw new Error(json.details || json.error || `HTTP ${res.status}`);
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitFeedback(target: PlaybookTargetRow, action: FeedbackAction) {
    try {
      setFeedbackLoadingId(`${target.id}:${action}`);
      setFeedbackMessage(null);
      const res = await fetch("/api/opportunities/targets/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerProfileId: target.customerProfileId,
          opportunityId: target.id,
          targetingProfileId: target.targetingProfileId ?? null,
          action,
          note: getFeedbackNote(action, target),
          convertedRevenueCents:
            action === "converted" ? target.estimatedRevenueCents : 0,
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        details?: string;
      };
      if (!res.ok || !json.success) {
        throw new Error(json.details || json.error || "Feedback failed");
      }
      setFeedbackMessage(`${getFeedbackLabel(action)} saved.`);
      if (action === "exclude" || action === "converted") {
        setData((prev) =>
          prev
            ? {
                ...prev,
                targets: prev.targets.filter((t) => t.id !== target.id),
                targetCount: Math.max(0, prev.targetCount - 1),
              }
            : null
        );
      }
      await load();
    } catch (e) {
      setFeedbackMessage(
        e instanceof Error ? e.message : "Failed to save feedback"
      );
    } finally {
      setFeedbackLoadingId(null);
    }
  }

  return (
    <div className="min-h-full bg-[#F8FAFC] pb-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link href="/opportunities" className={`${closeOsBtnSecondary} text-sm`}>
          ← Back to Opportunities
        </Link>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={closeOsBtnSecondary}
          >
            {loading ? "Refreshing…" : "Refresh targets"}
          </button>
          {data && (
            <Link href={buildDraftCampaignHref(data)} className={closeOsBtnPrimary}>
              Draft campaign
            </Link>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {feedbackMessage && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          {feedbackMessage}
        </div>
      )}

      {loading && !data && (
        <p className="text-sm text-slate-600">Loading playbook targets…</p>
      )}

      {data && (
        <>
          <header className="mb-8 rounded-2xl border border-slate-800 bg-slate-900 px-6 py-6 text-white shadow-lg md:px-8">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
                  Playbook review
                </p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
                  {data.campaignName}
                </h1>
                <p className="mt-3 max-w-3xl line-clamp-2 text-sm text-slate-300">
                  <span className="font-medium text-slate-200">Why now </span>
                  {oneSentence(data.strategicReason, 200)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${urgencyBadgeClass(
                    data.urgency
                  )}`}
                >
                  {labelize(data.urgency)}
                </span>
                <span className="rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-950 shadow-sm">
                  Manual review
                </span>
              </div>
            </div>

            <dl className="mt-6 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                <dt className="text-xs text-slate-400">Targets</dt>
                <dd className="mt-1 text-xl font-semibold">{data.targetCount}</dd>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                <dt className="text-xs text-slate-400">Revenue</dt>
                <dd className="mt-1 text-xl font-semibold text-emerald-400">
                  {formatCurrency(data.estimatedRevenueCents / 100)}
                </dd>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                <dt className="text-xs text-slate-400">Channel</dt>
                <dd className="mt-1 text-lg font-semibold">
                  {formatRecommendedChannel(data.recommendedChannel)}
                </dd>
              </div>
            </dl>

            <p className="mt-4 line-clamp-2 text-xs text-slate-400">
              <span className="font-medium text-slate-300">Next step </span>
              {oneSentence(data.recommendedAction, 180)} ·{" "}
              {labelize(data.launchSafetyStatus.replace(/_/g, " "))}
            </p>
          </header>

          {data.targets.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-slate-600 shadow-sm">
              <p className="font-medium text-slate-900">No targets in this playbook</p>
              <p className="mt-2 line-clamp-2 text-sm">
                List may have changed, or the URL slug /{" "}
                <code className="rounded bg-slate-100 px-1">?campaign=</code> does
                not match. Re-open from Opportunities.
              </p>
            </div>
          ) : (
            <div className="grid gap-4">
              {data.targets.map((target, index) => {
                const signal = buildWhyNowLine({
                  recognizedOpportunity: target.recognizedOpportunity,
                  bookingStatus: target.bookingStatus,
                  lastBookingType: target.lastBookingType,
                  daysSinceBooking: target.daysSinceBooking,
                  bookingTitle: target.bookingTitle,
                });
                const hasBookingMeta =
                  Boolean(target.bookingTitle) ||
                  Boolean(target.lastBookingAt) ||
                  Boolean(target.bookingStatus);

                return (
                  <article
                    key={target.id}
                    className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 p-4">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-slate-400">
                          #{index + 1}
                        </p>
                        <h2 className="mt-0.5 text-lg font-semibold text-slate-900">
                          {target.leadName}
                          {target.isMember && (
                            <span className="ml-2 rounded-md border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950">
                              Member
                            </span>
                          )}
                        </h2>
                        <p className="text-sm text-slate-600">
                          {target.phone ?? "—"}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${sourceBadgeClass(
                            target.sourceDisplayLabel
                          )}`}
                        >
                          {target.sourceDisplayLabel || "Source"}
                        </span>
                        <p className="text-sm font-semibold text-slate-900">
                          <span className="font-normal text-slate-500">
                            Revenue{" "}
                          </span>
                          {formatCurrency(target.estimatedRevenueCents / 100)}
                        </p>
                      </div>
                    </div>

                    <div className="space-y-3 p-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          Signal
                        </p>
                        <p className="mt-1 line-clamp-2 text-sm text-slate-800">
                          {signal}
                        </p>
                      </div>

                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                          Draft
                        </p>
                        <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-800">
                          {cleanDisplayMessage(target.recommendedMessage || "") ||
                            "(No SMS draft for this channel.)"}
                        </p>
                      </div>

                      <p className="line-clamp-2 text-xs text-slate-600">
                        <span className="font-medium text-slate-700">Campaign </span>
                        {target.recommendedCampaign}
                        <span className="mx-1.5 text-slate-300">·</span>
                        <span className="font-medium text-slate-700">Channel </span>
                        {formatRecommendedChannel(target.recommendedChannel)}
                      </p>

                      <p className="line-clamp-2 text-sm text-slate-700">
                        <span className="font-medium text-slate-600">Next step </span>
                        {oneSentence(target.nextBestAction, 200)}
                      </p>

                      {target.replyHandlingGoal?.trim() && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            Reply goal
                          </p>
                          <p className="mt-1 max-h-28 overflow-y-auto text-sm leading-snug text-slate-800">
                            {target.replyHandlingGoal}
                          </p>
                        </div>
                      )}

                      {target.objectionHandlingNotes?.trim() && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            Objection handling
                          </p>
                          <p className="mt-1 max-h-28 overflow-y-auto text-sm leading-snug text-slate-800">
                            {target.objectionHandlingNotes}
                          </p>
                        </div>
                      )}

                      {target.followUpPlan?.trim() && (
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                            Follow-up plan
                          </p>
                          <p className="mt-1 max-h-28 overflow-y-auto text-sm leading-snug text-slate-800">
                            {target.followUpPlan}
                          </p>
                        </div>
                      )}

                      <p className="line-clamp-2 text-xs text-slate-600">
                        <span className="font-medium text-slate-700">Offer </span>
                        {target.recommendedOffer}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2 border-t border-slate-200 bg-[#F8FAFC] px-4 py-3">
                      <Link
                        href={buildTargetOutboundHref(target)}
                        className={closeOsBtnSuccess}
                      >
                        Launch Revenue Motion
                      </Link>
                      {(
                        ["good_target", "wrong_offer", "exclude", "converted"] as const
                      ).map((action) => {
                        const busy = feedbackLoadingId === `${target.id}:${action}`;
                        return (
                          <button
                            key={action}
                            type="button"
                            disabled={Boolean(feedbackLoadingId)}
                            onClick={() => void submitFeedback(target, action)}
                            className={targetFeedbackButtonClass(action)}
                          >
                            {busy ? "Saving…" : getFeedbackLabel(action)}
                          </button>
                        );
                      })}
                    </div>

                    <details className="group border-t border-slate-200 bg-white">
                        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900 marker:hidden [&::-webkit-details-marker]:hidden">
                          <span className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1 group-open:border-slate-400 group-open:bg-white">
                            Details
                          </span>
                        </summary>
                        <div className="space-y-3 px-4 pb-4 text-sm text-slate-700">
                          {target.reason?.trim() && (
                            <div>
                              <p className="text-[11px] font-semibold uppercase text-slate-500">
                                AI reason
                              </p>
                              <p className="mt-1 line-clamp-6 whitespace-pre-wrap">
                                {target.reason}
                              </p>
                            </div>
                          )}
                          {target.opportunitySignalSummary?.trim() && (
                            <div>
                              <p className="text-[11px] font-semibold uppercase text-slate-500">
                                Signal summary
                              </p>
                              <p className="mt-1 line-clamp-4">{target.opportunitySignalSummary}</p>
                            </div>
                          )}
                          {target.aiConfidenceReason?.trim() && (
                            <div>
                              <p className="text-[11px] font-semibold uppercase text-slate-500">
                                Confidence
                              </p>
                              <p className="mt-1 line-clamp-6 whitespace-pre-wrap">
                                {target.aiConfidenceReason}
                              </p>
                            </div>
                          )}
                          {hasBookingMeta && (
                            <div>
                              <p className="text-[11px] font-semibold uppercase text-slate-500">
                                Booking
                              </p>
                              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-slate-600">
                                {target.bookingTitle && (
                                  <li>Title: {target.bookingTitle}</li>
                                )}
                                {target.lastBookingType && (
                                  <li>Type: {labelize(target.lastBookingType)}</li>
                                )}
                                {target.bookingStatus && (
                                  <li>Status: {labelize(target.bookingStatus)}</li>
                                )}
                                {target.lastBookingAt && (
                                  <li>When: {formatDate(target.lastBookingAt)}</li>
                                )}
                                {target.daysSinceBooking != null &&
                                  target.daysSinceBooking >= 0 && (
                                    <li>Days since anchor: {target.daysSinceBooking}</li>
                                  )}
                              </ul>
                            </div>
                          )}
                          <p className="text-[11px] text-slate-500">
                            Status: {labelize(target.status)} · Type:{" "}
                            {labelize(target.recognizedOpportunity)}
                          </p>
                        </div>
                      </details>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function PlaybookCampaignReviewPageWrapper() {
  return (
    <Suspense
      fallback={
        <div className="bg-[#F8FAFC] py-12 text-center text-sm font-medium text-slate-700">
          Loading playbook…
        </div>
      }
    >
      <PlaybookCampaignReviewPage />
    </Suspense>
  );
}
