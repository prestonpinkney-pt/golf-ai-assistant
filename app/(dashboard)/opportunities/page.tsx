"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { slugifyCampaignName } from "@/app/api/lib/closeos-playbook-engine";
import { buildWhyNowLine, firstSentence } from "@/lib/operator-ui-copy";

type RevenueSummary = {
  businessId: string;
  businessName: string;
  businessSlug: string;
  monthlyGoalCents: number;
  actualRevenueCents: number;
  remainingGapCents: number;
  openPipelineCents: number;
  knownPipelineCents: number;
  qualifiedLeadCount: number;
  revenueTbdCount: number;
  reviewOnlyCount: number;
  pipelineCoveragePercent: number;
  goalProgressPercent: number;
  goalCoveragePercent: number;
  goalStatus: "configured" | "missing" | "duplicate_resolved";
  reportingMonth: string;
  reportingStart: string;
  reportingEnd: string;
  generatedAt: string;
  revenueSource: "revenue_events_live";
  latestRevenueEventAt: string | null;
  latestRevenueInsertedAt: string | null;
  revenueEventCount: number;
  openOpportunityCount: number;
};

type OpportunityTarget = {
  id: string;
  opportunityId?: string;
  targetingProfileId: string | null;
  customerProfileId: string;
  externalCustomerId: string;

  opportunitySource?: string | null;
  sourceDisplayLabel?: string;

  leadName: string;
  email: string | null;
  phone: string | null;
  isMember?: boolean;

  totalSpendCents: number;
  visitCount: number;
  lastPurchaseAt: string | null;

  targetScore: number;
  confidence: number;
  opportunityType: string;
  estimatedRevenueCents: number;
  playbook: string;
  status?: string;

  recommendedOffer: string;
  reason: string;
  recommendedMessage: string;

  recognizedOpportunity: string;
  opportunitySignalSummary: string;
  nextBestAction: string;
  replyHandlingGoal: string;

  recommendedCampaign?: string;
  recommendedChannel?: string;
  aiConfidenceReason?: string;
  objectionHandlingNotes?: string;
  followUpPlan?: string;

  revenueReviewRequired?: boolean;
  pipelineCategory?: string;
  knownPipelineContributionCents?: number;

  lastBookingAt?: string | null;
  lastBookingType?: string | null;
  bookingStatus?: string | null;
  bookingTitle?: string | null;
  daysSinceBooking?: number | null;
};

type CloseOsPlaybookSummary = {
  id: string;
  campaignName: string;
  sourceMix: Record<string, number>;
  opportunityTypes: string[];
  targetCount: number;
  knownPipelineCents: number;
  qualifiedLeadCount: number;
  revenueTbdCount: number;
  estimatedRevenueCents: number;
  pipelineRevenueLabel?: string;
  averageConfidence: number;
  averagePriority: number;
  recommendedChannel: string;
  recommendedAction: string;
  strategicReason: string;
  urgency: string;
  targetsPreview: Array<{
    id: string;
    leadName: string;
    recommendedOffer: string;
    opportunitySource: string | null;
  }>;
  launchSafetyStatus: string;
};

const business = {
  fallbackName: "Primetime Golf",
};

const NO_STORE_FETCH: RequestInit = {
  cache: "no-store",
  headers: { "Cache-Control": "no-cache" },
};

function bustUrl(path: string) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_=${Date.now()}`;
}

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

function hasUsablePhone(phone: string | null | undefined) {
  if (!phone) return false;

  const digitsOnly = phone.replace(/\D/g, "");

  if (digitsOnly.length === 10) return true;
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) return true;

  return false;
}

function formatRecommendedChannel(channel: string | undefined) {
  if (!channel) return "SMS";
  if (channel === "review_only") return "Review only (no SMS draft)";
  if (channel === "sms") return "SMS (manual)";
  if (channel === "email") return "Email (manual)";
  return labelize(channel);
}

function urgencyBadgeClass(urgency: string) {
  const u = urgency.toLowerCase();
  if (u === "urgent")
    return "border border-red-200 bg-red-50 text-red-800";
  if (u === "high")
    return "border border-emerald-200 bg-emerald-50 text-emerald-800";
  if (u === "medium-high")
    return "border border-amber-200 bg-amber-50 text-amber-800";
  if (u === "medium")
    return "border border-sky-200 bg-sky-50 text-sky-700";
  return "border border-slate-300 bg-slate-100 text-slate-800";
}

function buildDraftCampaignHref(playbook: CloseOsPlaybookSummary) {
  const params = new URLSearchParams({
    playbook_campaign: playbook.campaignName,
    manual_draft: "1",
    target_count: String(playbook.targetCount),
  });
  return `/outbound?${params.toString()}`;
}

function sourceBadgeClass(label: string | undefined) {
  const l = (label ?? "").toLowerCase();
  if (l.includes("booking")) {
    return "border border-indigo-200 bg-indigo-50 text-indigo-900 ring-0";
  }
  if (l.includes("mailchimp")) {
    return "border border-emerald-200 bg-emerald-50 text-emerald-800 ring-0";
  }
  if (l.includes("purchase")) {
    return "border border-slate-300 bg-slate-50 text-slate-700 ring-0";
  }
  return "border border-slate-300 bg-slate-50 text-slate-700 ring-0";
}

const closeOsBtnSecondary =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900 no-underline shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
/** Playbook card: View targets (primary) */
const playbookViewTargetsBtn =
  "inline-flex items-center justify-center rounded-lg border border-emerald-700 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white no-underline shadow-sm transition hover:bg-emerald-700";
/** Playbook card: Draft campaign (secondary) */
const playbookDraftCampaignBtn =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-900 no-underline shadow-sm transition hover:bg-slate-50";

export default function OpportunitiesPage() {
  const [revenueSummary, setRevenueSummary] =
    useState<RevenueSummary | null>(null);
  const [revenueLoading, setRevenueLoading] = useState(true);

  const [targets, setTargets] = useState<OpportunityTarget[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState<string | null>(null);

  const [playbooks, setPlaybooks] = useState<CloseOsPlaybookSummary[]>([]);
  const [playbooksLoading, setPlaybooksLoading] = useState(true);
  const [playbooksError, setPlaybooksError] = useState<string | null>(null);
  const [campaignFilter, setCampaignFilter] = useState<string | null>(null);

  const loadRevenueSummary = useCallback(async (mode: "full" | "quiet" = "full") => {
    const quiet = mode === "quiet";
    if (!quiet) setRevenueLoading(true);
    try {
      const response = await fetch(bustUrl("/api/revenue/summary"), {
        method: "GET",
        ...NO_STORE_FETCH,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);

        throw new Error(
          errorData?.details ||
            errorData?.error ||
            `Failed to load revenue summary. Status: ${response.status}`
        );
      }

      const data = (await response.json()) as RevenueSummary;

      setRevenueSummary(data);
    } catch (error) {
      console.error("Failed to load revenue summary:", error);
    } finally {
      if (!quiet) setRevenueLoading(false);
    }
  }, []);

  const loadTargets = useCallback(async () => {
    try {
      setTargetsLoading(true);
      setTargetsError(null);

      const response = await fetch(bustUrl("/api/opportunities/targets"), {
        method: "GET",
        ...NO_STORE_FETCH,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);

        throw new Error(
          errorData?.details ||
            errorData?.error ||
            `Failed to load opportunities. Status: ${response.status}`
        );
      }

      const data = (await response.json()) as {
        targets?: OpportunityTarget[];
      };

      const safeTargets = Array.isArray(data.targets) ? data.targets : [];

      setTargets(safeTargets.filter((target) => hasUsablePhone(target.phone)));
    } catch (error) {
      console.error("Failed to load opportunity targets:", error);

      setTargetsError(
        error instanceof Error
          ? error.message
          : "Failed to load opportunity targets"
      );

      setTargets([]);
    } finally {
      setTargetsLoading(false);
    }
  }, []);

  const loadPlaybooks = useCallback(async () => {
    try {
      setPlaybooksLoading(true);
      setPlaybooksError(null);

      const response = await fetch(bustUrl("/api/opportunities/playbooks"), {
        method: "GET",
        ...NO_STORE_FETCH,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(
          errorData?.details ||
            errorData?.error ||
            `Failed to load playbooks. Status: ${response.status}`
        );
      }

      const data = (await response.json()) as {
        playbooks?: CloseOsPlaybookSummary[];
      };

      setPlaybooks(Array.isArray(data.playbooks) ? data.playbooks : []);
    } catch (error) {
      console.error("Failed to load playbooks:", error);
      setPlaybooksError(
        error instanceof Error ? error.message : "Failed to load playbooks"
      );
      setPlaybooks([]);
    } finally {
      setPlaybooksLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      if (!isMounted) return;

      await Promise.all([
        loadRevenueSummary("full"),
        loadTargets(),
        loadPlaybooks(),
      ]);
    }

    loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [loadRevenueSummary, loadTargets, loadPlaybooks]);

  async function refreshPageData() {
    setCampaignFilter(null);
    await Promise.all([
      loadRevenueSummary("full"),
      loadTargets(),
      loadPlaybooks(),
    ]);
  }

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadRevenueSummary("quiet");
    }, 60_000);
    return () => window.clearInterval(id);
  }, [loadRevenueSummary]);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") {
        void loadRevenueSummary("quiet");
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [loadRevenueSummary]);

  const businessName = revenueSummary?.businessName ?? business.fallbackName;

  const monthlyGoal = revenueSummary
    ? revenueSummary.monthlyGoalCents / 100
    : 22000;

  const actualRevenue = revenueSummary
    ? revenueSummary.actualRevenueCents / 100
    : 0;

  const remainingGap = revenueSummary
    ? revenueSummary.remainingGapCents / 100
    : monthlyGoal;

  const goalCoverage = revenueSummary?.goalCoveragePercent ?? 0;

  const targetKnownPipeline = useMemo(() => {
    return targets.reduce(
      (sum, target) =>
        sum + (target.knownPipelineContributionCents ?? 0) / 100,
      0
    );
  }, [targets]);

  const displayPipelineDollars =
    revenueSummary != null
      ? (revenueSummary.knownPipelineCents ?? revenueSummary.openPipelineCents) /
          100
      : targetKnownPipeline;

  const reviewNeededTargets = useMemo(
    () =>
      targets.filter(
        (t) =>
          t.revenueReviewRequired ||
          (t.recommendedChannel ?? "").toLowerCase() === "review_only"
      ).length,
    [targets]
  );

  const filteredTargets = useMemo(() => {
    if (!campaignFilter) return targets;
    return targets.filter(
      (t) => (t.recommendedCampaign ?? "") === campaignFilter
    );
  }, [targets, campaignFilter]);

  const topTargets = filteredTargets.slice(0, 5);

  return (
    <main className="min-h-screen text-slate-900">
      <section className="motion-card rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8">
          <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-600">
                Revenue workspace
              </p>

              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl">
                {businessName} Revenue Opportunities
              </h1>

              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">
                Phone-qualified revenue targets, playbook groups, and operator-controlled sends in one review workspace.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={refreshPageData}
                disabled={
                  targetsLoading || revenueLoading || playbooksLoading
                }
                className={closeOsBtnSecondary}
              >
                {targetsLoading || revenueLoading || playbooksLoading
                  ? "Refreshing..."
                  : "Refresh opportunities"}
              </button>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-slate-600">
                  Monthly Goal
                </p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {formatCurrency(monthlyGoal)}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-slate-950 md:p-6">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <p className="text-sm font-medium text-emerald-700">Actual revenue</p>
                <p className="mt-2 text-4xl font-semibold tracking-tight">
                  {revenueLoading
                    ? "Loading..."
                    : formatCurrency(actualRevenue)}
                </p>
                <p className="mt-2 text-sm text-emerald-900/70">
                  {goalCoverage}% of {formatCurrency(monthlyGoal)} monthly goal
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:w-[460px]">
                <div>
                  <p className="text-sm text-emerald-900/70">Remaining gap</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {revenueLoading
                      ? "Loading..."
                      : formatCurrency(remainingGap)}
                  </p>
                </div>

                <div>
                  <p className="text-sm text-emerald-900/70">Known pipeline</p>
                  <p className="mt-1 text-2xl font-semibold">
                    {formatCurrency(displayPipelineDollars)}
                  </p>
                </div>
              </div>
            </div>

            {revenueSummary && remainingGap > 0 ? (
              <p
                className={`mt-4 text-sm font-medium ${
                  displayPipelineDollars < remainingGap
                    ? "text-amber-700"
                    : "text-emerald-700"
                }`}
              >
                {displayPipelineDollars < remainingGap
                  ? "Known pipeline does not cover the gap yet."
                  : "Known pipeline can cover the goal if converted."}{" "}
                Pipeline coverage: {revenueSummary.pipelineCoveragePercent ?? 0}% (known dollars only, not revenue TBD).
              </p>
            ) : null}

            <div className="mt-6 h-2 overflow-hidden rounded-full bg-white">
              <div
                className="h-full rounded-full bg-emerald-600"
                style={{ width: `${Math.min(goalCoverage, 100)}%` }}
              />
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3 lg:grid-cols-6">
            <div className="motion-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                Actual Revenue
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-900">
                {revenueLoading
                  ? "Loading..."
                  : formatCurrency(actualRevenue)}
              </p>
            </div>

            <div className="motion-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                Remaining Gap
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-900">
                {revenueLoading
                  ? "Loading..."
                  : formatCurrency(remainingGap)}
              </p>
            </div>

            <div className="motion-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                Known Pipeline
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-900">
                {formatCurrency(displayPipelineDollars)}
              </p>
            </div>

            <div className="motion-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                Qualified Leads
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-900">
                {revenueLoading ? "—" : (revenueSummary?.qualifiedLeadCount ?? "—")}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">API-wide (reachable)</p>
            </div>

            <div className="motion-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                Revenue TBD
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-900">
                {revenueLoading ? "—" : (revenueSummary?.revenueTbdCount ?? "—")}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">Configure offers to forecast $</p>
            </div>

            <div className="motion-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-600">
                Review Needed
              </p>
              <p className="mt-2 text-xl font-semibold text-slate-900">
                {targetsLoading ? "Loading..." : reviewNeededTargets}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">This page&apos;s targets</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-6 lg:px-8">
        <div className="motion-card rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-600">
            CloseOS AI closing intelligence
          </p>

          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
            Today&apos;s best opportunities
          </h2>

          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Highest-signal phone-qualified targets. Full drafts and actions live
            on each campaign&apos;s review page.
          </p>
        </div>

        <div className="mt-6 rounded-xl border border-slate-200 bg-[#F1F5F9] p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
            Playbook engine
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
            Playbooks
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Grouped by campaign. Manual review only — use{" "}
            <span className="font-semibold text-slate-900">View targets</span>{" "}
            for the full list.
          </p>

          {playbooksError && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {playbooksError}
            </div>
          )}

          {playbooksLoading && (
            <p className="mt-4 text-sm text-slate-600">Loading playbooks…</p>
          )}

          {!playbooksLoading && playbooks.length === 0 && (
            <p className="mt-4 text-sm text-slate-600">
              No playbook groups yet — add open opportunities or refresh.
            </p>
          )}

          {!playbooksLoading && playbooks.length > 0 && (
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {playbooks.map((pb) => (
                <div
                  key={pb.id}
                  className="flex flex-col motion-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">
                      {pb.campaignName}
                    </h3>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${urgencyBadgeClass(
                        pb.urgency
                      )}`}
                    >
                      {labelize(pb.urgency)}
                    </span>
                  </div>

                  <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                    <div>
                      <span className="text-slate-500">Targets </span>
                      <span className="font-semibold text-slate-900">
                        {pb.targetCount}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Known pipeline </span>
                      <span className="font-semibold text-slate-900">
                        {pb.pipelineRevenueLabel ?? formatCurrency(pb.knownPipelineCents / 100)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500">Channel </span>
                      <span className="font-semibold text-slate-900">
                        {formatRecommendedChannel(pb.recommendedChannel)}
                      </span>
                    </div>
                  </dl>

                  <p className="mt-3 text-xs leading-snug text-slate-600">
                    <span className="font-medium text-slate-800">Why now </span>
                    {firstSentence(pb.strategicReason, 260)}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <Link
                      href={`/opportunities/playbooks/${slugifyCampaignName(pb.campaignName)}?campaign=${encodeURIComponent(pb.campaignName)}`}
                      className={playbookViewTargetsBtn}
                    >
                      View targets
                    </Link>
                    <Link
                      href={buildDraftCampaignHref(pb)}
                      className={playbookDraftCampaignBtn}
                    >
                      Draft campaign
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-600">
              Top targets preview
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Showing up to 5 of your open, phone-qualified opportunities from{" "}
              <span className="font-medium text-slate-700">
                ai_opportunities
              </span>
              {campaignFilter ? (
                <>
                  {" "}
                  · filtered by campaign{" "}
                  <span className="font-semibold text-slate-900">
                    {campaignFilter}
                  </span>
                </>
              ) : null}
              .
            </p>
            {campaignFilter && (
              <button
                type="button"
                onClick={() => setCampaignFilter(null)}
                className={`${closeOsBtnSecondary} mt-2 py-1.5 text-left`}
              >
                Clear campaign filter
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => {
                void loadTargets();
                void loadPlaybooks();
              }}
              disabled={targetsLoading || playbooksLoading}
              className={`${closeOsBtnSecondary} rounded-full py-1.5`}
            >
              {targetsLoading || playbooksLoading ? "Refreshing..." : "Refresh"}
            </button>

            <div className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm">
              {targetsLoading
                ? "Loading opportunities..."
                : campaignFilter
                  ? `${filteredTargets.length} shown · ${targets.length} total`
                  : `${targets.length} open`}
            </div>
          </div>
        </div>

        {targetsError && (
          <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {targetsError}
          </div>
        )}

        {targetsLoading && (
          <div className="mt-6 motion-card rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500">
            Loading opportunities...
          </div>
        )}

        {!targetsLoading && targets.length === 0 && (
          <div className="mt-6 motion-card rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">
              No open opportunities
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              CloseOS has no open reachable opportunities right now. Run Google
              Calendar sync, Square sync, Mailchimp sync, or opportunity
              creation routes to generate fresh records.
            </p>
          </div>
        )}

        {!targetsLoading &&
          targets.length > 0 &&
          filteredTargets.length === 0 &&
          campaignFilter && (
            <div className="mt-6 rounded-xl border border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-950">
              No targets match campaign &quot;{campaignFilter}&quot;.{" "}
              <button
                type="button"
                className="ml-1 rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-50"
                onClick={() => setCampaignFilter(null)}
              >
                Clear filter
              </button>
            </div>
          )}

        {topTargets.length > 0 && (
          <div id="opportunity-targets-list" className="mt-5 grid gap-2">
            {topTargets.map((target, index) => {
              const rc = (target.recommendedCampaign ?? "").trim();
              const campaignParam = rc || target.playbook;
              const reviewHref = `/opportunities/playbooks/${slugifyCampaignName(campaignParam)}?campaign=${encodeURIComponent(campaignParam)}`;
              const whyNow = buildWhyNowLine({
                recognizedOpportunity: target.recognizedOpportunity,
                bookingStatus: target.bookingStatus ?? null,
                lastBookingType: target.lastBookingType ?? null,
                daysSinceBooking: target.daysSinceBooking ?? null,
                bookingTitle: target.bookingTitle ?? null,
              });
              const campaignLabel = campaignParam || "—";

              return (
                <article
                  key={target.id}
                  className="flex max-h-[160px] min-h-[112px] items-stretch gap-3 motion-card rounded-xl border border-slate-200 bg-white px-3 py-3 shadow-sm sm:gap-4 sm:px-4"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-bold text-slate-500">
                        #{index + 1}
                      </span>
                      {target.sourceDisplayLabel ? (
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-tight ${sourceBadgeClass(
                            target.sourceDisplayLabel
                          )}`}
                        >
                          {target.sourceDisplayLabel}
                        </span>
                      ) : null}
                    </div>
                    <p className="truncate text-sm font-semibold text-slate-900">
                      {target.leadName}
                    </p>
                    <p className="truncate font-mono text-xs text-slate-600">
                      {target.phone ?? "—"}
                    </p>
                    <p className="truncate text-xs text-slate-700">
                      <span className="font-semibold text-slate-800">
                        Campaign:{" "}
                      </span>
                      {campaignLabel}
                    </p>
                    <p className="line-clamp-2 text-xs leading-snug text-slate-600">
                      <span className="font-semibold text-slate-800">
                        Why now:{" "}
                      </span>
                      {whyNow}
                    </p>
                    <p className="text-xs font-semibold text-slate-900">
                      Revenue:{" "}
                      {target.revenueReviewRequired
                        ? "Revenue TBD"
                        : formatCurrency(target.estimatedRevenueCents / 100)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col justify-center border-l border-slate-100 pl-3 sm:pl-4">
                    <Link href={reviewHref} className={playbookViewTargetsBtn}>
                      Open review
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
