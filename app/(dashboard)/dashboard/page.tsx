"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { slugifyCampaignName } from "@/app/api/lib/closeos-playbook-engine";
import { buildWhyNowLine, firstSentence, oneSentence } from "@/lib/operator-ui-copy";

type RevenueSummary = {
  businessId: string;
  businessName: string;
  businessSlug: string;
  monthlyGoalCents: number;
  actualRevenueCents: number;
  remainingGapCents: number;
  goalCoveragePercent: number;
};

type OpportunityTarget = {
  id: string;
  customerProfileId: string;
  externalCustomerId: string;
  opportunitySource?: string | null;
  sourceDisplayLabel?: string;
  leadName: string;
  phone: string | null;
  estimatedRevenueCents: number;
  playbook: string;
  status?: string;
  confidence: number;
  recognizedOpportunity: string;
  recommendedCampaign?: string;
  recommendedChannel?: string;
  recommendedMessage?: string;
  bookingStatus?: string | null;
  lastBookingType?: string | null;
  daysSinceBooking?: number | null;
  bookingTitle?: string | null;
};

type CloseOsPlaybookSummary = {
  id: string;
  campaignName: string;
  sourceMix: Record<string, number>;
  targetCount: number;
  estimatedRevenueCents: number;
  averageConfidence: number;
  recommendedChannel: string;
  strategicReason: string;
  urgency: string;
};

type AdvisorSuggestion = {
  id: string;
  type: string;
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  confidence: number;
  revenueImpactCents: number;
  targetCount: number;
  reasoning: string;
  recommendedAction: string;
  actionHref: string | null;
  supportingSignals: string[];
  caution?: string;
  suggestedMessageAngle?: string;
};

type SalesAdvisorPayload = {
  generatedAt: string;
  headline: string;
  summary: string;
  suggestions: AdvisorSuggestion[];
};

const URGENCY_RANK: Record<string, number> = {
  urgent: 5,
  high: 4,
  "medium-high": 3,
  medium: 2,
  low: 1,
};

const btnPrimary =
  "inline-flex items-center justify-center rounded-lg border border-[#0F172A] bg-[#0F172A] px-3 py-2 text-sm font-semibold text-white no-underline shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const btnSecondary =
  "inline-flex items-center justify-center rounded-lg border border-[#CBD5E1] bg-white px-3 py-2 text-sm font-semibold text-[#0F172A] no-underline shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";
const btnPrimarySm =
  "inline-flex items-center justify-center rounded-lg border border-[#0F172A] bg-[#0F172A] px-2.5 py-1.5 text-xs font-semibold text-white no-underline shadow-sm transition hover:bg-slate-800";

function urgencyScore(urgency: string) {
  return URGENCY_RANK[urgency.toLowerCase()] ?? 0;
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
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function hasUsablePhone(phone: string | null | undefined) {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return true;
  if (digits.length === 11 && digits.startsWith("1")) return true;
  return false;
}

function formatRecommendedChannel(channel: string | undefined) {
  if (!channel) return "SMS";
  if (channel === "review_only") return "Review only";
  if (channel === "sms") return "SMS";
  if (channel === "email") return "Email";
  return labelize(channel);
}

function sourceBadgeClass(label: string | undefined) {
  const l = (label ?? "").toLowerCase();
  if (l.includes("booking")) return "border border-indigo-200 bg-indigo-50 text-indigo-900";
  if (l.includes("mailchimp")) return "border border-emerald-200 bg-emerald-50 text-emerald-800";
  if (l.includes("purchase")) return "border border-slate-300 bg-slate-50 text-slate-700";
  return "border border-slate-300 bg-slate-50 text-slate-700";
}

function urgencyBadgeClass(urgency: string) {
  const u = urgency.toLowerCase();
  if (u === "urgent") return "border border-red-200 bg-red-50 text-red-900";
  if (u === "high") return "border border-orange-200 bg-orange-50 text-orange-950";
  if (u === "medium-high") return "border border-amber-300 bg-amber-100 text-amber-950";
  if (u === "medium") return "border border-sky-200 bg-sky-50 text-sky-950";
  return "border border-slate-300 bg-slate-100 text-slate-800";
}

function advisorPriorityBadgeClass(priority: AdvisorSuggestion["priority"]) {
  if (priority === "critical") return "border border-red-200 bg-red-50 text-red-900";
  if (priority === "high") return "border border-orange-200 bg-orange-50 text-orange-950";
  if (priority === "medium") return "border border-sky-200 bg-sky-50 text-sky-950";
  return "border border-slate-300 bg-slate-100 text-slate-800";
}

function reasoningAtMostTwoSentences(text: string) {
  const trimmed = text.trim();
  const parts = trimmed.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length <= 2) return trimmed;
  return `${parts[0]} ${parts[1]}`;
}

function playbookHref(campaignName: string) {
  return `/opportunities/playbooks/${slugifyCampaignName(campaignName)}?campaign=${encodeURIComponent(campaignName)}`;
}

function buildDraftCampaignHref(playbook: CloseOsPlaybookSummary) {
  const params = new URLSearchParams({
    playbook_campaign: playbook.campaignName,
    manual_draft: "1",
    target_count: String(playbook.targetCount),
  });
  return `/outbound?${params.toString()}`;
}

function sortPlaybooksByPriority(list: CloseOsPlaybookSummary[]) {
  return [...list].sort((a, b) => {
    const du = urgencyScore(b.urgency) - urgencyScore(a.urgency);
    if (du !== 0) return du;
    return b.estimatedRevenueCents - a.estimatedRevenueCents;
  });
}

function campaignUrgencyMap(playbooks: CloseOsPlaybookSummary[]) {
  const map = new Map<string, number>();
  for (const pb of playbooks) map.set(pb.campaignName, urgencyScore(pb.urgency));
  return map;
}

function targetAttentionScore(t: OpportunityTarget, urgencyByCampaign: Map<string, number>) {
  let s = 0;
  const source = (t.opportunitySource ?? "").toLowerCase();
  const label = (t.sourceDisplayLabel ?? "").toLowerCase();
  const rec = t.recognizedOpportunity;

  if (source === "google_calendar_booking" || label.includes("booking")) s += 130;
  if (rec === "booking_cancelled_recovery") s += 95;
  if (rec === "lesson_rebooking_due") s += 85;
  if (rec === "practice_to_lesson") s += 45;
  if (rec === "recent_buyer_follow_up") s += 20;

  const campaign = (t.recommendedCampaign ?? "").trim();
  s += (urgencyByCampaign.get(campaign) ?? 0) * 14;
  s += Math.min(t.estimatedRevenueCents / 4000, 30);
  s += Math.min(t.confidence, 100) * 0.12;
  return s;
}

function draftPreview(text: string | undefined) {
  return oneSentence(text, 96);
}

export default function CloseOsDashboardPage() {
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null);
  const [playbooks, setPlaybooks] = useState<CloseOsPlaybookSummary[]>([]);
  const [targets, setTargets] = useState<OpportunityTarget[]>([]);

  const [revenueLoading, setRevenueLoading] = useState(true);
  const [playbooksLoading, setPlaybooksLoading] = useState(true);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [revenueError, setRevenueError] = useState<string | null>(null);
  const [playbooksError, setPlaybooksError] = useState<string | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [advisor, setAdvisor] = useState<SalesAdvisorPayload | null>(null);
  const [advisorLoading, setAdvisorLoading] = useState(true);
  const [advisorError, setAdvisorError] = useState<string | null>(null);

  const loadRevenue = useCallback(async () => {
    setRevenueError(null);
    const res = await fetch("/api/revenue/summary", { cache: "no-store" });
    const json = (await res.json()) as RevenueSummary & { error?: string; details?: string };
    if (!res.ok) throw new Error(json.details || json.error || `Revenue HTTP ${res.status}`);
    setRevenue(json);
  }, []);

  const loadPlaybooks = useCallback(async () => {
    setPlaybooksError(null);
    const res = await fetch("/api/opportunities/playbooks", { cache: "no-store" });
    const json = (await res.json()) as {
      playbooks?: CloseOsPlaybookSummary[];
      error?: string;
      details?: string;
    };
    if (!res.ok) throw new Error(json.details || json.error || `Playbooks HTTP ${res.status}`);
    setPlaybooks(Array.isArray(json.playbooks) ? json.playbooks : []);
  }, []);

  const loadTargets = useCallback(async () => {
    setTargetsError(null);
    const res = await fetch("/api/opportunities/targets", { cache: "no-store" });
    const json = (await res.json()) as {
      targets?: OpportunityTarget[];
      error?: string;
      details?: string;
    };
    if (!res.ok) throw new Error(json.details || json.error || `Targets HTTP ${res.status}`);
    const raw = Array.isArray(json.targets) ? json.targets : [];
    setTargets(raw.filter((t) => hasUsablePhone(t.phone)));
  }, []);

  const loadAdvisor = useCallback(async () => {
    setAdvisorError(null);
    const res = await fetch("/api/opportunities/advisor", { cache: "no-store" });
    const json = (await res.json()) as SalesAdvisorPayload & { error?: string; details?: string };
    if (!res.ok) throw new Error(json.details || json.error || `Advisor HTTP ${res.status}`);
    setAdvisor({
      generatedAt: json.generatedAt,
      headline: json.headline,
      summary: json.summary,
      suggestions: Array.isArray(json.suggestions) ? json.suggestions : [],
    });
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    setRevenueLoading(true);
    setPlaybooksLoading(true);
    setTargetsLoading(true);
    setAdvisorLoading(true);
    setRevenueError(null);
    setPlaybooksError(null);
    setTargetsError(null);
    setAdvisorError(null);

    try {
      await loadRevenue();
    } catch (e) {
      setRevenueError(e instanceof Error ? e.message : "Revenue failed");
      setRevenue(null);
    } finally {
      setRevenueLoading(false);
    }
    try {
      await loadPlaybooks();
    } catch (e) {
      setPlaybooksError(e instanceof Error ? e.message : "Playbooks failed");
      setPlaybooks([]);
    } finally {
      setPlaybooksLoading(false);
    }
    try {
      await loadTargets();
    } catch (e) {
      setTargetsError(e instanceof Error ? e.message : "Targets failed");
      setTargets([]);
    } finally {
      setTargetsLoading(false);
    }
    try {
      await loadAdvisor();
    } catch (e) {
      setAdvisorError(e instanceof Error ? e.message : "Advisor failed");
      setAdvisor(null);
    } finally {
      setAdvisorLoading(false);
    }
    setRefreshing(false);
  }, [loadRevenue, loadPlaybooks, loadTargets, loadAdvisor]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const sortedPlaybooks = useMemo(() => sortPlaybooksByPriority(playbooks), [playbooks]);
  const bestPlaybook = sortedPlaybooks[0] ?? null;
  const playbookBoard = sortedPlaybooks.slice(0, 4);

  const pipelineCents = useMemo(() => targets.reduce((sum, t) => sum + t.estimatedRevenueCents, 0), [targets]);

  const urgentTargets = useMemo(() => {
    const urgencyByCampaign = campaignUrgencyMap(playbooks);
    return [...targets]
      .sort((a, b) => targetAttentionScore(b, urgencyByCampaign) - targetAttentionScore(a, urgencyByCampaign))
      .slice(0, 5);
  }, [targets, playbooks]);

  const gapCents = revenue?.remainingGapCents ?? 0;
  const gapCoverage = gapCents > 0 ? Math.round((pipelineCents / gapCents) * 100) : 100;
  const coverageLabel =
    gapCents <= 0
      ? "Goal already covered."
      : pipelineCents < gapCents
        ? "More pipeline needed."
        : "Pipeline can cover the goal if converted.";

  const goalPct = Math.max(0, Math.min(100, revenue?.goalCoveragePercent ?? 0));
  const businessName = revenue?.businessName ?? "Primetime Golf";

  const openCount = targets.length;
  const convertedCount = targets.filter((t) => (t.status ?? "").toLowerCase() === "converted").length;
  const excludedCount = targets.filter((t) => {
    const st = (t.status ?? "").toLowerCase();
    return st === "excluded" || st === "bad_data" || st === "not_interested";
  }).length;
  const manualReviewCount = targets.filter((t) => (t.recommendedChannel ?? "").toLowerCase() === "review_only").length;
  const touchedTodayCount = Math.min(urgentTargets.length, 5);

  const mailchimpSignal =
    playbooks.some((pb) => Object.keys(pb.sourceMix ?? {}).some((k) => k.toLowerCase().includes("mailchimp"))) ||
    targets.some((t) => {
      const src = (t.opportunitySource ?? "").toLowerCase();
      const lbl = (t.sourceDisplayLabel ?? "").toLowerCase();
      return src.includes("mailchimp") || lbl.includes("mailchimp");
    });
  const calendarSignal = targets.some((t) => {
    const src = (t.opportunitySource ?? "").toLowerCase();
    const lbl = (t.sourceDisplayLabel ?? "").toLowerCase();
    return src === "google_calendar_booking" || lbl.includes("booking");
  });
  const whooshSignal = targets.some((t) => (t.externalCustomerId ?? "").toLowerCase().startsWith("whoosh:"));

  const integrationCards = [
    {
      name: "Square revenue",
      status: revenue && !revenueError ? "Active" : revenueError ? "Needs review" : "No recent signal",
    },
    {
      name: "Google Calendar bookings",
      status: calendarSignal ? "Active" : "No recent signal",
    },
    {
      name: "Whoosh roster",
      status: whooshSignal ? "Active" : "No recent signal",
    },
    {
      name: "Mailchimp",
      status: mailchimpSignal ? "Active" : "No recent signal",
    },
  ] as const;

  const loadingAny =
    revenueLoading || playbooksLoading || targetsLoading || advisorLoading || refreshing;

  const advisorCards = useMemo(() => advisor?.suggestions?.slice(0, 5) ?? [], [advisor]);

  return (
    <div className="bg-[#F8FAFC] pb-10 text-[#0F172A]">
      <header className="flex flex-col gap-4 border-b border-slate-200 bg-white px-1 py-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[#0F172A] md:text-3xl">
            CloseOS Dashboard
          </h1>
          <p className="mt-2 text-sm text-[#475569]">Your revenue command center for today.</p>
          <p className="mt-1 text-xs font-medium text-slate-500">Workspace: {businessName}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void refreshAll()} disabled={loadingAny} className={btnSecondary}>
            {loadingAny ? "Refreshing…" : "Refresh"}
          </button>
          <Link href="/opportunities" className={btnPrimary}>
            View Opportunities
          </Link>
        </div>
      </header>

      {(revenueError || playbooksError || targetsError || advisorError) && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {[revenueError, playbooksError, targetsError, advisorError].filter(Boolean).join(" · ")}
        </div>
      )}

      <section className="mt-6 rounded-xl border border-indigo-200 bg-gradient-to-br from-white to-indigo-50/40 p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-indigo-900/80">AI Sales Advisor</p>
        {advisorLoading && <p className="mt-2 text-sm text-[#475569]">Reading your stack…</p>}
        {!advisorLoading && advisor && (
          <>
            <h2 className="mt-2 text-lg font-semibold tracking-tight text-[#0F172A]">{advisor.headline}</h2>
            <p className="mt-1 text-sm text-[#475569]">{advisor.summary}</p>
            {advisorCards.length === 0 ? (
              <p className="mt-3 text-sm text-[#475569]">No suggestions yet. Refresh after sync.</p>
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {advisorCards.map((s) => (
                  <div
                    key={s.id}
                    className="flex flex-col rounded-lg border border-slate-200 bg-white/90 p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${advisorPriorityBadgeClass(s.priority)}`}>
                        {labelize(s.priority)}
                      </span>
                      <span className="text-[10px] font-medium text-slate-500">{s.targetCount} people</span>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-[#0F172A]">{s.title}</p>
                    <p className="mt-1 text-xs text-[#475569]">{reasoningAtMostTwoSentences(s.reasoning)}</p>
                    <p className="mt-2 text-xs font-semibold text-[#0F172A]">Do next</p>
                    <p className="text-xs text-[#475569]">{s.recommendedAction}</p>
                    {s.suggestedMessageAngle ? (
                      <>
                        <p className="mt-2 text-xs font-semibold text-[#0F172A]">Angle</p>
                        <p className="text-xs italic text-[#475569]">&ldquo;{s.suggestedMessageAngle}&rdquo;</p>
                      </>
                    ) : null}
                    {s.caution ? (
                      <p className="mt-2 text-[11px] font-medium text-amber-800">{s.caution}</p>
                    ) : null}
                    {s.actionHref ? (
                      <div className="mt-3">
                        <Link href={s.actionHref} className={btnPrimarySm}>
                          Open
                        </Link>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section className="mt-6 grid gap-4 xl:grid-cols-2">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#475569]">Revenue Goal Tracker</p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
              <p className="text-xs text-[#475569]">Monthly goal</p>
              <p className="mt-1 font-semibold text-[#0F172A]">{revenueLoading ? "…" : formatCurrency((revenue?.monthlyGoalCents ?? 0) / 100)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
              <p className="text-xs text-[#475569]">Actual revenue</p>
              <p className="mt-1 font-semibold text-[#0F172A]">{revenueLoading ? "…" : formatCurrency((revenue?.actualRevenueCents ?? 0) / 100)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
              <p className="text-xs text-[#475569]">Remaining gap</p>
              <p className="mt-1 font-semibold text-[#0F172A]">{revenueLoading ? "…" : formatCurrency(gapCents / 100)}</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
              <p className="text-xs text-[#475569]">Open pipeline</p>
              <p className="mt-1 font-semibold text-[#0F172A]">{targetsLoading ? "…" : formatCurrency(pipelineCents / 100)}</p>
            </div>
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between text-xs font-semibold text-[#475569]">
              <span>Goal progress</span>
              <span>{Math.round(goalPct)}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-emerald-600" style={{ width: `${goalPct}%` }} />
            </div>
          </div>

          <p className="mt-3 text-sm text-[#475569]">
            You are {formatCurrency(gapCents / 100)} away from goal. Current open pipeline covers {Math.max(0, gapCoverage)}% of the gap.
          </p>
          <p className={`mt-1 text-sm font-semibold ${pipelineCents < gapCents ? "text-amber-700" : "text-emerald-700"}`}>{coverageLabel}</p>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#475569]">Today&apos;s Closing Focus</p>
          {playbooksLoading && <p className="mt-3 text-sm text-[#475569]">Loading best play…</p>}
          {!playbooksLoading && !bestPlaybook && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              No active playbooks. Run syncs or refresh opportunities.
            </p>
          )}
          {!playbooksLoading && bestPlaybook && (
            <>
              <p className="mt-3 text-base font-semibold text-[#0F172A]">Best play today: {bestPlaybook.campaignName}</p>
              <p className="mt-1 text-sm text-[#475569]">Close this first. {firstSentence(bestPlaybook.strategicReason, 210)}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${urgencyBadgeClass(bestPlaybook.urgency)}`}>{labelize(bestPlaybook.urgency)}</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-700">{bestPlaybook.targetCount} targets</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-700">{formatCurrency(bestPlaybook.estimatedRevenueCents / 100)} pipeline</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-semibold text-slate-700">{formatRecommendedChannel(bestPlaybook.recommendedChannel)}</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Link href={playbookHref(bestPlaybook.campaignName)} className={btnPrimarySm}>Review targets</Link>
                <Link href={buildDraftCampaignHref(bestPlaybook)} className={btnSecondary}>Draft campaign</Link>
              </div>
            </>
          )}
        </article>
      </section>

      <section className="mt-8 grid gap-4 xl:grid-cols-[1.25fr_1fr]">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#475569]">Deal Queue</p>
          <p className="mt-1 text-sm text-[#475569]">Ready to contact now.</p>
          {targetsLoading && <p className="mt-3 text-sm text-[#475569]">Loading deal queue…</p>}
          {!targetsLoading && urgentTargets.length === 0 && (
            <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-[#475569]">
              No urgent deals yet. Refresh after sync.
            </p>
          )}
          {urgentTargets.length > 0 && (
            <div className="mt-3 space-y-2">
              {urgentTargets.map((t) => {
                const campaign = (t.recommendedCampaign ?? "").trim() || t.playbook;
                const href = playbookHref(campaign);
                const whyNow = buildWhyNowLine({
                  recognizedOpportunity: t.recognizedOpportunity,
                  bookingStatus: t.bookingStatus ?? null,
                  lastBookingType: t.lastBookingType ?? null,
                  daysSinceBooking: t.daysSinceBooking ?? null,
                  bookingTitle: t.bookingTitle ?? null,
                });
                return (
                  <div key={t.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {t.sourceDisplayLabel ? <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${sourceBadgeClass(t.sourceDisplayLabel)}`}>{t.sourceDisplayLabel}</span> : null}
                        <span className="text-[10px] font-semibold text-slate-500">{campaign}</span>
                      </div>
                      <p className="mt-1 truncate text-sm font-semibold text-[#0F172A]">{t.leadName}</p>
                      <p className="font-mono text-xs text-[#475569]">{t.phone}</p>
                      <p className="mt-1 line-clamp-1 text-xs text-[#475569]"><span className="font-semibold text-[#0F172A]">Why now: </span>{whyNow}</p>
                      <p className="line-clamp-1 text-xs text-[#475569]"><span className="font-semibold text-[#0F172A]">Draft: </span>{draftPreview(t.recommendedMessage)}</p>
                      <p className="mt-1 text-xs font-semibold text-[#0F172A]">{formatCurrency(t.estimatedRevenueCents / 100)}</p>
                    </div>
                    <Link href={href} className={`${btnPrimarySm} shrink-0`}>Open review</Link>
                  </div>
                );
              })}
            </div>
          )}
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#475569]">Playbook Board</p>
          <div className="mt-3 space-y-2">
            {playbookBoard.map((pb) => (
              <div key={pb.id} className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-semibold text-[#0F172A]">{pb.campaignName}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${urgencyBadgeClass(pb.urgency)}`}>{labelize(pb.urgency)}</span>
                </div>
                <p className="mt-2 text-xs text-[#475569]">
                  {pb.targetCount} targets · {formatCurrency(pb.estimatedRevenueCents / 100)} · {pb.averageConfidence}% confidence · {formatRecommendedChannel(pb.recommendedChannel)}
                </p>
                <div className="mt-2"><Link href={playbookHref(pb.campaignName)} className={btnPrimarySm}>View targets</Link></div>
              </div>
            ))}
            {!playbooksLoading && playbookBoard.length === 0 && <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-[#475569]">No campaign board yet.</p>}
          </div>
        </article>
      </section>

      <section className="mt-8 grid gap-4 xl:grid-cols-2">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#475569]">Goal Action Plan</p>
          <p className="mt-2 text-sm text-[#475569]">
            Gap is {formatCurrency(gapCents / 100)}. Prioritize {bestPlaybook?.campaignName ?? "the top playbook"} ({formatCurrency((bestPlaybook?.estimatedRevenueCents ?? 0) / 100)}), then work the deal queue to increase conversion pace.
          </p>
          <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-[#475569]">
            <li>Review urgent playbook first.</li>
            <li>Launch manual draft for the best campaign.</li>
            <li>Follow up top 5 deals before adding lower-priority pipeline.</li>
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            {bestPlaybook && <Link href={playbookHref(bestPlaybook.campaignName)} className={btnPrimarySm}>Review urgent playbook</Link>}
            {bestPlaybook && <Link href={buildDraftCampaignHref(bestPlaybook)} className={btnSecondary}>Draft best campaign</Link>}
            <Link href="/opportunities" className={btnSecondary}>Follow up deal queue</Link>
          </div>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#475569]">Activity / Progress Tracker</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3"><p className="text-xs text-[#475569]">Open opportunities</p><p className="mt-1 text-lg font-semibold text-[#0F172A]">{openCount}</p></div>
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3"><p className="text-xs text-[#475569]">Converted</p><p className="mt-1 text-lg font-semibold text-[#0F172A]">{convertedCount}</p></div>
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3"><p className="text-xs text-[#475569]">Excluded</p><p className="mt-1 text-lg font-semibold text-[#0F172A]">{excludedCount}</p></div>
            <div className="rounded-lg border border-slate-200 bg-[#F8FAFC] p-3"><p className="text-xs text-[#475569]">Manual review required</p><p className="mt-1 text-lg font-semibold text-[#0F172A]">{manualReviewCount}</p></div>
          </div>
          <p className="mt-3 text-sm text-[#475569]">Pipeline touched today: {touchedTodayCount}</p>
        </article>
      </section>

      <section className="mt-8">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[#475569]">Data Health</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {integrationCards.map((card) => (
            <div key={card.name} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
              <p className="text-xs font-semibold text-[#0F172A]">{card.name}</p>
              <p className={`mt-1 text-xs font-semibold ${card.status === "Active" ? "text-emerald-700" : card.status === "Needs review" ? "text-amber-700" : "text-slate-500"}`}>{card.status}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
