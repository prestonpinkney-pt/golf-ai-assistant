"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { slugifyCampaignName } from "@/app/api/lib/closeos-playbook-engine";
import { buildWhyNowLine, firstSentence, oneSentence } from "@/lib/operator-ui-copy";

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
  customerProfileId: string;
  externalCustomerId: string;
  opportunitySource?: string | null;
  sourceDisplayLabel?: string;
  leadName: string;
  phone: string | null;
  estimatedRevenueCents: number;
  revenueReviewRequired?: boolean;
  knownPipelineContributionCents?: number;
  pipelineCategory?: string;
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
  knownPipelineCents: number;
  qualifiedLeadCount: number;
  revenueTbdCount: number;
  estimatedRevenueCents: number;
  pipelineRevenueLabel?: string;
  averageConfidence: number;
  recommendedChannel: string;
  strategicReason: string;
  urgency: string;
};

type AdvisorStrand =
  | "close_first"
  | "build_pipeline"
  | "hidden_upsell"
  | "needs_review"
  | "do_not_prioritize";

type AdvisorSuggestion = {
  id: string;
  type: string;
  strand: AdvisorStrand;
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  confidence: number;
  revenueImpactCents: number;
  targetCount: number;
  reasoning: string;
  recommendedAction: string;
  actionHref: string;
  supportingSignals: string[];
  caution?: string;
  suggestedMessageAngle?: string;
};

type SalesAdvisorPayload = {
  generatedAt: string;
  businessHeadline: string;
  headline: string;
  pipelineShortfallCents: number;
  summary: string;
  suggestions: AdvisorSuggestion[];
};

type RecentConversation = {
  id: string;
  contactName: string;
  preview: string;
  direction: string;
  status: string | null;
  lastMessageAt: string | null;
};

type ConversationsPayload = {
  generatedAt: string;
  conversations: RecentConversation[];
};

type RevenueTimeseriesPayload = {
  range: "30d" | "month";
  points: Array<{ date: string; revenueCents: number }>;
  generatedAt: string;
};

type SourceSlice = {
  label: string;
  count: number;
  color: string;
};

const NO_STORE_FETCH: RequestInit = {
  cache: "no-store",
  headers: { "Cache-Control": "no-cache" },
};

const URGENCY_RANK: Record<string, number> = {
  urgent: 5,
  high: 4,
  "medium-high": 3,
  medium: 2,
  low: 1,
};

const SOURCE_COLORS = ["#059669", "#38bdf8", "#22c55e", "#a78bfa", "#f97316"];

function bustUrl(path: string) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_=${Date.now()}`;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value || 0);
}

function formatDateRange(start?: string, end?: string) {
  if (!start || !end) return "This month";
  try {
    const s = new Date(start);
    const e = new Date(end);
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${e.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    })}`;
  } catch {
    return "This month";
  }
}

function formatDateTime(iso: string | null | undefined) {
  if (!iso) return "Not synced yet";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "Not synced yet";
  }
}

function labelize(value: string | undefined | null) {
  return (value ?? "Unknown")
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

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "PG";
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
}

function urgencyScore(urgency: string) {
  return URGENCY_RANK[urgency.toLowerCase()] ?? 0;
}

function priorityClass(priority: string) {
  const p = priority.toLowerCase();
  if (p === "critical" || p === "urgent" || p === "high") {
    return "border-emerald-400/40 bg-emerald-400/10 text-emerald-700";
  }
  if (p === "medium-high" || p === "medium") {
    return "border-sky-200 bg-sky-50 text-sky-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function sourceLabel(target: OpportunityTarget) {
  const raw = target.sourceDisplayLabel ?? target.opportunitySource ?? "Operator Signal";
  const lower = raw.toLowerCase();
  if (lower.includes("booking") || lower.includes("calendar")) return "Booking Intelligence";
  if (lower.includes("mailchimp")) return "Mailchimp Intent";
  if (lower.includes("purchase") || lower.includes("square")) return "Purchase Signal";
  if (lower.includes("website") || lower.includes("form")) return "Website Form";
  if (lower.includes("referral")) return "Referral";
  if ((target.externalCustomerId ?? "").toLowerCase().startsWith("whoosh:")) return "Purchase Signal";
  return labelize(raw);
}

function playbookHref(campaignName: string) {
  return `/opportunities/playbooks/${slugifyCampaignName(campaignName)}?campaign=${encodeURIComponent(campaignName)}`;
}

function targetDraftHref(target: OpportunityTarget) {
  const campaign = (target.recommendedCampaign ?? "").trim() || target.playbook || "Opportunity Review";
  const params = new URLSearchParams({
    manual_draft: "1",
    opportunity_id: target.id,
    playbook_campaign: campaign,
    lead_name: target.leadName,
  });
  return `/outbound?${params.toString()}`;
}

function sortPlaybooksByPriority(list: CloseOsPlaybookSummary[]) {
  return [...list].sort((a, b) => {
    const urgencyDelta = urgencyScore(b.urgency) - urgencyScore(a.urgency);
    if (urgencyDelta !== 0) return urgencyDelta;
    return b.knownPipelineCents - a.knownPipelineCents;
  });
}

function campaignUrgencyMap(playbooks: CloseOsPlaybookSummary[]) {
  const map = new Map<string, number>();
  for (const playbook of playbooks) map.set(playbook.campaignName, urgencyScore(playbook.urgency));
  return map;
}

function knownPipelineForTarget(target: OpportunityTarget) {
  if (target.revenueReviewRequired) return 0;
  return target.knownPipelineContributionCents ?? target.estimatedRevenueCents ?? 0;
}

function knownPipelineForPlaybook(playbook: CloseOsPlaybookSummary) {
  return playbook.knownPipelineCents > 0 ? playbook.knownPipelineCents : 0;
}

function targetAttentionScore(target: OpportunityTarget, urgencyByCampaign: Map<string, number>) {
  let score = 0;
  const recognized = target.recognizedOpportunity;
  const source = sourceLabel(target).toLowerCase();

  if (source.includes("booking")) score += 120;
  if (recognized === "booking_cancelled_recovery") score += 95;
  if (recognized === "lesson_rebooking_due") score += 85;
  if (recognized === "practice_to_lesson") score += 50;
  if (recognized === "recent_buyer_follow_up") score += 30;

  const campaign = (target.recommendedCampaign ?? "").trim();
  score += (urgencyByCampaign.get(campaign) ?? 0) * 14;
  score += Math.min(knownPipelineForTarget(target) / 4000, 35);
  score += Math.min(target.confidence, 100) * 0.12;
  return score;
}

function concisePreview(text: string | undefined, fallback = "Review the recommended next touch.") {
  const preview = oneSentence(text, 92);
  return preview || fallback;
}

function sourceBreakdown(targets: OpportunityTarget[]): SourceSlice[] {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const label = sourceLabel(target);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count], index) => ({
      label,
      count,
      color: SOURCE_COLORS[index] ?? "#64748b",
    }));
}

function donutBackground(slices: SourceSlice[]) {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  if (total <= 0) return "conic-gradient(rgba(148,163,184,0.22) 0deg 360deg)";

  let cursor = 0;
  const stops = slices.map((slice) => {
    const start = cursor;
    const end = cursor + (slice.count / total) * 360;
    cursor = end;
    return `${slice.color} ${start}deg ${end}deg`;
  });
  return `conic-gradient(${stops.join(", ")})`;
}

function chartPoints(points: RevenueTimeseriesPayload["points"]) {
  const width = 500;
  const height = 180;
  if (points.length === 0) return "";
  const max = Math.max(...points.map((point) => point.revenueCents), 1);
  return points
    .map((point, index) => {
      const x = points.length === 1 ? width : (index / (points.length - 1)) * width;
      const y = height - (point.revenueCents / max) * 140 - 20;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`motion-card group rounded-[22px] border border-slate-200 bg-white shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

function CardHeader({
  title,
  action,
  eyebrow,
}: {
  title: string;
  action?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        {eyebrow ? <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700/70">{eyebrow}</p> : null}
        <h2 className="text-sm font-semibold tracking-[-0.015em] text-slate-950">{title}</h2>
      </div>
      {action}
    </div>
  );
}

function PanelButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center rounded-full border border-slate-200 bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-900 transition hover:border-emerald-300/40 hover:bg-emerald-50 hover:text-emerald-900"
    >
      {children}
    </Link>
  );
}

export default function CloseOsDashboardPage() {
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null);
  const [playbooks, setPlaybooks] = useState<CloseOsPlaybookSummary[]>([]);
  const [targets, setTargets] = useState<OpportunityTarget[]>([]);
  const [advisor, setAdvisor] = useState<SalesAdvisorPayload | null>(null);
  const [conversations, setConversations] = useState<RecentConversation[]>([]);
  const [timeseries, setTimeseries] = useState<RevenueTimeseriesPayload | null>(null);

  const [revenueLoading, setRevenueLoading] = useState(true);
  const [playbooksLoading, setPlaybooksLoading] = useState(true);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [advisorLoading, setAdvisorLoading] = useState(true);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [timeseriesLoading, setTimeseriesLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [revenueError, setRevenueError] = useState<string | null>(null);
  const [playbooksError, setPlaybooksError] = useState<string | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [advisorError, setAdvisorError] = useState<string | null>(null);
  const [conversationsError, setConversationsError] = useState<string | null>(null);
  const [timeseriesError, setTimeseriesError] = useState<string | null>(null);

  const loadRevenue = useCallback(async (mode: "full" | "quiet" = "full") => {
    const quiet = mode === "quiet";
    if (!quiet) {
      setRevenueLoading(true);
      setRevenueError(null);
    }
    try {
      const res = await fetch(bustUrl("/api/revenue/summary"), NO_STORE_FETCH);
      const json = (await res.json()) as RevenueSummary & { error?: string; details?: string };
      if (!res.ok) throw new Error(json.details || json.error || `Revenue HTTP ${res.status}`);
      setRevenue(json);
    } catch (error) {
      if (!quiet) {
        setRevenueError(error instanceof Error ? error.message : "Revenue failed");
        setRevenue(null);
      } else {
        console.error(error);
      }
    } finally {
      if (!quiet) setRevenueLoading(false);
    }
  }, []);

  const loadPlaybooks = useCallback(async (mode: "full" | "quiet" = "full") => {
    const quiet = mode === "quiet";
    if (!quiet) {
      setPlaybooksLoading(true);
      setPlaybooksError(null);
    }
    try {
      const res = await fetch(bustUrl("/api/opportunities/playbooks"), NO_STORE_FETCH);
      const json = (await res.json()) as {
        playbooks?: CloseOsPlaybookSummary[];
        error?: string;
        details?: string;
      };
      if (!res.ok) throw new Error(json.details || json.error || `Playbooks HTTP ${res.status}`);
      setPlaybooks(Array.isArray(json.playbooks) ? json.playbooks : []);
    } catch (error) {
      if (!quiet) {
        setPlaybooksError(error instanceof Error ? error.message : "Playbooks failed");
        setPlaybooks([]);
      } else {
        console.error(error);
      }
    } finally {
      if (!quiet) setPlaybooksLoading(false);
    }
  }, []);

  const loadTargets = useCallback(async (mode: "full" | "quiet" = "full") => {
    const quiet = mode === "quiet";
    if (!quiet) {
      setTargetsLoading(true);
      setTargetsError(null);
    }
    try {
      const res = await fetch(bustUrl("/api/opportunities/targets"), NO_STORE_FETCH);
      const json = (await res.json()) as {
        targets?: OpportunityTarget[];
        error?: string;
        details?: string;
      };
      if (!res.ok) throw new Error(json.details || json.error || `Targets HTTP ${res.status}`);
      const raw = Array.isArray(json.targets) ? json.targets : [];
      setTargets(raw.filter((target) => hasUsablePhone(target.phone)));
    } catch (error) {
      if (!quiet) {
        setTargetsError(error instanceof Error ? error.message : "Targets failed");
        setTargets([]);
      } else {
        console.error(error);
      }
    } finally {
      if (!quiet) setTargetsLoading(false);
    }
  }, []);

  const loadAdvisor = useCallback(async (mode: "full" | "quiet" = "full") => {
    const quiet = mode === "quiet";
    if (!quiet) {
      setAdvisorLoading(true);
      setAdvisorError(null);
    }
    try {
      const res = await fetch(bustUrl("/api/opportunities/advisor"), NO_STORE_FETCH);
      const json = (await res.json()) as SalesAdvisorPayload & { error?: string; details?: string };
      if (!res.ok) throw new Error(json.details || json.error || `Advisor HTTP ${res.status}`);
      const suggestionsRaw = Array.isArray(json.suggestions) ? json.suggestions : [];
      const suggestions: AdvisorSuggestion[] = suggestionsRaw.map((raw) => {
        const suggestion = raw as AdvisorSuggestion & { strand?: AdvisorStrand };
        return {
          ...suggestion,
          strand: suggestion.strand ?? "build_pipeline",
          actionHref: suggestion.actionHref || "/opportunities",
        };
      });
      setAdvisor({
        generatedAt: json.generatedAt,
        businessHeadline: json.businessHeadline ?? json.headline ?? "",
        headline: json.headline ?? json.businessHeadline ?? "",
        pipelineShortfallCents:
          typeof json.pipelineShortfallCents === "number" ? json.pipelineShortfallCents : 0,
        summary: json.summary,
        suggestions,
      });
    } catch (error) {
      if (!quiet) {
        setAdvisorError(error instanceof Error ? error.message : "Advisor failed");
        setAdvisor(null);
      } else {
        console.error(error);
      }
    } finally {
      if (!quiet) setAdvisorLoading(false);
    }
  }, []);

  const loadConversations = useCallback(async (mode: "full" | "quiet" = "full") => {
    const quiet = mode === "quiet";
    if (!quiet) {
      setConversationsLoading(true);
      setConversationsError(null);
    }
    try {
      const res = await fetch(bustUrl("/api/conversations/recent"), NO_STORE_FETCH);
      const json = (await res.json()) as ConversationsPayload & { error?: string; details?: string };
      if (!res.ok) throw new Error(json.details || json.error || `Conversations HTTP ${res.status}`);
      setConversations(Array.isArray(json.conversations) ? json.conversations : []);
    } catch (error) {
      if (!quiet) {
        setConversationsError(error instanceof Error ? error.message : "Conversations failed");
        setConversations([]);
      } else {
        console.error(error);
      }
    } finally {
      if (!quiet) setConversationsLoading(false);
    }
  }, []);

  const loadTimeseries = useCallback(async (mode: "full" | "quiet" = "full") => {
    const quiet = mode === "quiet";
    if (!quiet) {
      setTimeseriesLoading(true);
      setTimeseriesError(null);
    }
    try {
      const res = await fetch(bustUrl("/api/revenue/timeseries?range=30d"), NO_STORE_FETCH);
      const json = (await res.json()) as RevenueTimeseriesPayload & { error?: string; details?: string };
      if (!res.ok) throw new Error(json.details || json.error || `Timeseries HTTP ${res.status}`);
      setTimeseries(json);
    } catch (error) {
      if (!quiet) {
        setTimeseriesError(error instanceof Error ? error.message : "Revenue trend failed");
        setTimeseries(null);
      } else {
        console.error(error);
      }
    } finally {
      if (!quiet) setTimeseriesLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      loadRevenue("full"),
      loadPlaybooks("full"),
      loadTargets("full"),
      loadAdvisor("full"),
      loadConversations("full"),
      loadTimeseries("full"),
    ]);
    setRefreshing(false);
  }, [loadRevenue, loadPlaybooks, loadTargets, loadAdvisor, loadConversations, loadTimeseries]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadRevenue("quiet");
      void loadTimeseries("quiet");
    }, 30_000);
    return () => window.clearInterval(id);
  }, [loadRevenue, loadTimeseries]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void loadPlaybooks("quiet");
      void loadTargets("quiet");
      void loadAdvisor("quiet");
      void loadConversations("quiet");
    }, 60_000);
    return () => window.clearInterval(id);
  }, [loadPlaybooks, loadTargets, loadAdvisor, loadConversations]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadRevenue("quiet");
        void loadPlaybooks("quiet");
        void loadTargets("quiet");
        void loadAdvisor("quiet");
        void loadConversations("quiet");
        void loadTimeseries("quiet");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [loadRevenue, loadPlaybooks, loadTargets, loadAdvisor, loadConversations, loadTimeseries]);

  const sortedPlaybooks = useMemo(() => sortPlaybooksByPriority(playbooks), [playbooks]);
  const bestPlaybook = sortedPlaybooks[0] ?? null;
  const campaignBoard = sortedPlaybooks.slice(0, 3);
  const advisorSuggestions = advisor?.suggestions?.slice(0, 3) ?? [];

  const urgentTargets = useMemo(() => {
    const urgencyByCampaign = campaignUrgencyMap(playbooks);
    return [...targets]
      .sort((a, b) => targetAttentionScore(b, urgencyByCampaign) - targetAttentionScore(a, urgencyByCampaign))
      .slice(0, 5);
  }, [targets, playbooks]);

  const draftTargets = useMemo(() => {
    return [...targets]
      .filter(
        (target) =>
          Boolean(target.recommendedMessage?.trim()) &&
          (target.recommendedChannel ?? "").toLowerCase() !== "review_only" &&
          hasUsablePhone(target.phone)
      )
      .sort((a, b) => knownPipelineForTarget(b) - knownPipelineForTarget(a))
      .slice(0, 3);
  }, [targets]);

  const sources = useMemo(() => sourceBreakdown(targets), [targets]);
  const sourceTotal = sources.reduce((sum, source) => sum + source.count, 0);

  const actualRevenueCents = revenue?.actualRevenueCents ?? 0;
  const goalConfigured = revenue?.goalStatus === "configured" && (revenue?.monthlyGoalCents ?? 0) > 0;
  const goalPct = goalConfigured ? Math.max(0, Math.min(100, revenue?.goalCoveragePercent ?? 0)) : 0;
  const gapCents = goalConfigured ? revenue?.remainingGapCents ?? 0 : 0;
  const knownPipelineCents = revenue?.knownPipelineCents ?? targets.reduce((sum, target) => sum + knownPipelineForTarget(target), 0);
  const pipelineCoverage = gapCents > 0 ? Math.min(100, Math.round((knownPipelineCents / gapCents) * 100)) : knownPipelineCents > 0 ? 100 : 0;
  const openOpportunityCount = revenue?.openOpportunityCount ?? targets.length;
  const recoveryPipelineCount = targets.filter((target) => target.recognizedOpportunity === "booking_cancelled_recovery").length;
  const loadingAny =
    revenueLoading ||
    playbooksLoading ||
    targetsLoading ||
    advisorLoading ||
    conversationsLoading ||
    timeseriesLoading ||
    refreshing;
  const dateRange = formatDateRange(revenue?.reportingStart, revenue?.reportingEnd);
  const businessName = revenue?.businessName ?? "Primetime Golf";
  const chartLine = chartPoints(timeseries?.points ?? []);
  const chartHasRevenue = (timeseries?.points ?? []).some((point) => point.revenueCents > 0);
  const advisorPrimaryHref =
    advisorSuggestions[0]?.actionHref ?? (bestPlaybook ? playbookHref(bestPlaybook.campaignName) : "/opportunities");

  const errors = [revenueError, playbooksError, targetsError, advisorError, conversationsError, timeseriesError].filter(Boolean);

  return (
    <div className="min-h-screen text-slate-900">
      {errors.length > 0 ? (
        <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errors.join(" · ")}
        </div>
      ) : null}

      <section className="relative mb-5 overflow-hidden rounded-3xl border border-emerald-100 bg-white p-5 shadow-sm md:p-6">
        <div className="ambient-orb absolute -right-12 -top-16 h-40 w-40 rounded-full bg-emerald-100/70 blur-2xl" />
        <div className="ambient-orb absolute -bottom-20 left-1/3 h-36 w-36 rounded-full bg-green-100/60 blur-2xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700/70">
            <span className="live-dot h-2 w-2 rounded-full bg-emerald-500 text-emerald-500" />
            Revenue command
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-[-0.05em] text-slate-950 md:text-4xl">Overview</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            AI revenue operating system for golf businesses.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="rounded-full border border-slate-200 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-800">
            {dateRange}
          </div>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={loadingAny}
            className="rounded-full border border-emerald-300/30 bg-emerald-50 px-4 py-2 text-xs font-semibold text-emerald-900 transition hover:-translate-y-0.5 hover:bg-emerald-100 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
          >
            {loadingAny ? "Refreshing..." : "Refresh"}
          </button>
        </div>
        </div>
      </section>

      <section className="mb-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Actual Revenue",
            value: revenueLoading && !revenue ? "..." : formatCurrency(actualRevenueCents / 100),
            meta: revenue?.revenueEventCount ? `${revenue.revenueEventCount} live events` : "Live revenue feed",
            icon: "$",
          },
          {
            label: "Recovery Pipeline",
            value: targetsLoading ? "..." : formatCompactNumber(recoveryPipelineCount),
            meta: "Cancelled lesson targets",
            icon: "B",
          },
          {
            label: "New Conversations",
            value: conversationsLoading ? "..." : conversations.length > 0 ? formatCompactNumber(conversations.length) : "—",
            meta: conversations.length > 0 ? "Recent messages" : "No conversation data yet",
            icon: "M",
          },
          {
            label: "Open Opportunities",
            value: targetsLoading && !revenue ? "..." : formatCompactNumber(openOpportunityCount),
            meta: `${revenue?.revenueTbdCount ?? 0} revenue TBD`,
            icon: "O",
          },
        ].map((item) => (
          <Card key={item.label} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-50 text-sm font-bold text-emerald-700 transition group-hover:scale-105">
                {item.icon}
              </div>
              <span className="text-xs font-semibold text-emerald-700">{item.meta}</span>
            </div>
            <p className="mt-4 text-xs font-medium text-slate-600">{item.label}</p>
            <p className="mt-1 text-3xl font-semibold tracking-[-0.05em] text-slate-950">{item.value}</p>
          </Card>
        ))}
      </section>

      <Card className="mb-5 p-5">
        <CardHeader
          title="What To Do First"
          eyebrow={advisorLoading ? "Seller advisor" : businessName}
          action={<PanelButton href={advisorPrimaryHref}>Open focus</PanelButton>}
        />
        {advisorError ? (
          <InlineError message="Unable to load advisor guidance." onRetry={() => void loadAdvisor("full")} />
        ) : advisorLoading && !advisor ? (
          <p className="mt-4 text-sm font-medium shimmer-text">Reading pipeline, gap, and urgency...</p>
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-[1.3fr_1fr]">
            <div className="rounded-2xl border border-emerald-300/15 bg-emerald-50 p-4">
              <p className="text-lg font-semibold tracking-[-0.03em] text-slate-950">
                {advisor?.businessHeadline || advisor?.headline || bestPlaybook?.campaignName || "Review the opportunity queue"}
              </p>
              <p className="mt-2 text-sm leading-6 text-emerald-900/70">
                {advisor?.summary ||
                  (bestPlaybook
                    ? firstSentence(bestPlaybook.strategicReason, 180)
                    : "No advisor recommendation is available yet. Start with the highest-priority opportunities.")}
              </p>
            </div>
            <div className="space-y-2">
              {(advisorSuggestions.length > 0 ? advisorSuggestions : []).map((suggestion) => (
                <Link
                  key={suggestion.id}
                  href={suggestion.actionHref}
                  className="block rounded-2xl border border-slate-200 bg-slate-50 p-3 transition hover:bg-slate-100"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-950">{suggestion.title}</p>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${priorityClass(suggestion.priority)}`}>
                      {labelize(suggestion.priority)}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-slate-500">{suggestion.recommendedAction}</p>
                </Link>
              ))}
              {advisorSuggestions.length === 0 && bestPlaybook ? (
                <Link
                  href={playbookHref(bestPlaybook.campaignName)}
                  className="block rounded-2xl border border-slate-200 bg-slate-50 p-3 transition hover:bg-slate-100"
                >
                  <p className="text-sm font-semibold text-slate-950">{bestPlaybook.campaignName}</p>
                  <p className="mt-1 line-clamp-1 text-xs text-slate-500">{firstSentence(bestPlaybook.strategicReason, 120)}</p>
                </Link>
              ) : null}
            </div>
          </div>
        )}
      </Card>

      <section className="grid gap-5 xl:grid-cols-[1.18fr_0.82fr]">
        <div className="grid gap-5">
          <Card className="p-5">
            <CardHeader title="Revenue Goal Tracker" action={<PanelButton href="/opportunities">View pipeline</PanelButton>} />
            {revenueLoading && !revenue ? (
              <p className="mt-4 text-sm font-medium shimmer-text">Loading revenue status...</p>
            ) : revenueError ? (
              <InlineError message="Unable to load revenue summary." onRetry={() => void loadRevenue("full")} />
            ) : goalConfigured ? (
              <>
                <div className="mt-5 grid gap-3 sm:grid-cols-4">
                  <Metric label="Monthly Goal" value={formatCurrency((revenue?.monthlyGoalCents ?? 0) / 100)} />
                  <Metric label="Actual Revenue" value={formatCurrency(actualRevenueCents / 100)} />
                  <Metric label="Remaining Gap" value={formatCurrency(gapCents / 100)} />
                  <Metric label="Known Pipeline" value={formatCurrency(knownPipelineCents / 100)} accent />
                </div>
                <div className="mt-5">
                  <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-600">
                    <span>{Math.round(goalPct)}% of monthly goal</span>
                    <span>{pipelineCoverage}% gap coverage</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-400 transition-[width] duration-700 ease-out" style={{ width: `${goalPct}%` }} />
                  </div>
                  <p className="mt-3 text-sm leading-6 text-slate-600">
                    Known pipeline only includes opportunities with forecastable revenue. Qualified leads and review-only items stay out of pipeline dollars.
                  </p>
                  <p className="mt-2 text-xs text-slate-500">
                    Last updated: {formatDateTime(revenue?.generatedAt)} · Latest revenue event: {formatDateTime(revenue?.latestRevenueEventAt)}
                  </p>
                </div>
              </>
            ) : (
              <div className="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-50 p-5">
                <p className="text-lg font-semibold tracking-[-0.03em] text-emerald-900">Goal not configured</p>
                <p className="mt-2 text-sm text-emerald-900/75">Set a monthly goal to track progress, remaining gap, and goal coverage.</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Metric label="Actual Revenue" value={formatCurrency(actualRevenueCents / 100)} />
                  <Metric label="Known Pipeline" value={formatCurrency(knownPipelineCents / 100)} accent />
                </div>
                <p className="mt-3 text-xs text-emerald-900/60">
                  Last updated: {formatDateTime(revenue?.generatedAt)}
                </p>
              </div>
            )}
          </Card>

          <Card className="p-5">
            <CardHeader
              title="AI Revenue Opportunities"
              eyebrow={advisor?.summary ? "What to work first" : undefined}
              action={<PanelButton href="/opportunities">View all</PanelButton>}
            />
            {playbooksError ? (
              <InlineError message="Unable to load playbooks." onRetry={() => void loadPlaybooks("full")} />
            ) : playbooksLoading ? (
              <p className="mt-4 text-sm font-medium shimmer-text">Loading playbooks...</p>
            ) : sortedPlaybooks.length === 0 ? (
              <EmptyState title="No active playbooks" copy="Run a sync to surface lesson recovery, rebooking, membership, event, and nurture plays." />
            ) : (
              <div className="mt-4 divide-y divide-white/[0.06]">
                {sortedPlaybooks.slice(0, 5).map((playbook) => {
                  const knownPipeline = knownPipelineForPlaybook(playbook);
                  const revenueLabel =
                    knownPipeline > 0
                      ? formatCurrency(knownPipeline / 100)
                      : playbook.revenueTbdCount > 0
                        ? "Revenue TBD"
                        : "No known pipeline";
                  return (
                    <Link
                      key={playbook.id}
                      href={playbookHref(playbook.campaignName)}
                      className="grid gap-3 py-3 transition hover:bg-slate-50 sm:grid-cols-[1fr_auto_auto]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-950">{playbook.campaignName}</p>
                        <p className="mt-1 line-clamp-1 text-xs text-slate-600">{firstSentence(playbook.strategicReason, 120)}</p>
                      </div>
                      <div className="text-sm font-semibold text-slate-900 sm:text-right">{revenueLabel}</div>
                      <span className={`h-fit rounded-full border px-2.5 py-1 text-[10px] font-semibold ${priorityClass(playbook.urgency)}`}>
                        {labelize(playbook.urgency)}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <CardHeader title="Urgent Targets" action={<PanelButton href="/opportunities">View all opportunities</PanelButton>} />
            {targetsError ? (
              <InlineError message="Unable to load urgent targets." onRetry={() => void loadTargets("full")} />
            ) : targetsLoading ? (
              <p className="mt-4 text-sm font-medium shimmer-text">Loading urgent targets...</p>
            ) : urgentTargets.length === 0 ? (
              <EmptyState title="No urgent targets" copy="No reachable high-signal targets are available right now." />
            ) : (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {urgentTargets.slice(0, 4).map((target) => {
                  const campaign = (target.recommendedCampaign ?? "").trim() || target.playbook || labelize(target.recognizedOpportunity);
                  const whyNow = buildWhyNowLine({
                    recognizedOpportunity: target.recognizedOpportunity,
                    bookingStatus: target.bookingStatus ?? null,
                    lastBookingType: target.lastBookingType ?? null,
                    daysSinceBooking: target.daysSinceBooking ?? null,
                    bookingTitle: target.bookingTitle ?? null,
                  });
                  return (
                    <Link
                      key={target.id}
                      href={playbookHref(campaign)}
                      className="rounded-2xl border border-slate-200 bg-slate-50 p-3 transition hover:bg-slate-100"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-950">{target.leadName}</p>
                          <p className="mt-1 truncate text-xs text-slate-500">{campaign}</p>
                        </div>
                        <span className="text-xs font-semibold text-emerald-900">
                          {knownPipelineForTarget(target) > 0 ? formatCurrency(knownPipelineForTarget(target) / 100) : "TBD"}
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-1 text-xs text-slate-600">{firstSentence(whyNow, 120)}</p>
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <CardHeader title="Revenue Over Time" action={<span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700">This month</span>} />
            {timeseriesError ? (
              <InlineError message="Unable to load revenue trend." onRetry={() => void loadTimeseries("full")} />
            ) : timeseriesLoading && !timeseries ? (
              <p className="mt-4 text-sm font-medium shimmer-text">Loading revenue trend...</p>
            ) : !chartHasRevenue ? (
              <EmptyState title="Revenue trend not available yet" copy="Revenue trend appears after completed revenue events sync into the last 30 days." />
            ) : (
              <div className="mt-5 h-56 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="relative h-full overflow-hidden rounded-xl">
                  <div className="absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.08)_1px,transparent_1px)] bg-[size:100%_25%,20%_100%]" />
                  <svg viewBox="0 0 500 180" className="relative h-full w-full">
                    <defs>
                      <linearGradient id="revenueLine" x1="0" x2="1" y1="0" y2="0">
                        <stop stopColor="#10b981" />
                        <stop offset="1" stopColor="#059669" />
                      </linearGradient>
                    </defs>
                    <polyline
                      className="draw-line"
                      fill="none"
                      points={chartLine}
                      stroke="url(#revenueLine)"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="4"
                    />
                  </svg>
                  <div className="absolute right-3 top-3 rounded-xl border border-emerald-200 bg-white/90 px-3 py-2 shadow-sm">
                    <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700/70">
                      <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-500 text-emerald-500" />
                      Live total
                    </p>
                    <p className="text-sm font-semibold text-slate-950">{formatCurrency(actualRevenueCents / 100)}</p>
                  </div>
                </div>
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">
              Protected 30-day revenue trend from completed revenue events. No customer-level data is returned.
            </p>
          </Card>
        </div>

        <div className="grid gap-5">
          <Card className="p-5">
            <CardHeader title="Opportunities by Source" />
            <div className="mt-5 grid gap-5 sm:grid-cols-[160px_1fr]">
              <div className="relative mx-auto h-40 w-40 rounded-full" style={{ background: donutBackground(sources) }}>
                <div className="absolute inset-6 flex flex-col items-center justify-center rounded-full border border-slate-200 bg-white text-center">
                  <span className="text-3xl font-semibold tracking-[-0.05em] text-slate-950">{sourceTotal}</span>
                  <span className="text-xs text-slate-500">signals</span>
                </div>
              </div>
              <div className="space-y-3">
                {sources.length === 0 ? (
                  <p className="text-sm text-slate-600">No source mix yet.</p>
                ) : (
                  sources.map((source) => (
                    <div key={source.label} className="flex items-center justify-between gap-3 text-sm">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: source.color }} />
                        <span className="truncate text-slate-700">{source.label}</span>
                      </div>
                      <span className="font-semibold text-slate-950">{source.count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <CardHeader title="Recent Conversations" action={<PanelButton href="/conversations">View all</PanelButton>} />
            {conversationsError ? (
              <InlineError message="Unable to load conversations." onRetry={() => void loadConversations("full")} />
            ) : conversationsLoading ? (
              <p className="mt-4 text-sm font-medium shimmer-text">Loading conversations...</p>
            ) : conversations.length === 0 ? (
              <EmptyState title="No recent conversations yet" copy="Customer messages will appear here after inbound or reviewed outbound activity exists." />
            ) : (
              <div className="mt-4 space-y-3">
                {conversations.map((conversation, index) => (
                  <Link key={`${conversation.id}:${conversation.lastMessageAt ?? "unknown"}:${index}`} href="/conversations" className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 transition hover:bg-slate-100">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-xs font-bold text-emerald-700">
                      {initials(conversation.contactName)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-950">{conversation.contactName}</p>
                      <p className="truncate text-xs text-slate-600">{conversation.preview || "No message preview"}</p>
                    </div>
                    <span className="text-[11px] font-semibold text-slate-500">{formatDateTime(conversation.lastMessageAt)}</span>
                  </Link>
                ))}
              </div>
            )}
            <div className="mt-4">
              <PanelButton href="/conversations">Go to conversations</PanelButton>
            </div>
          </Card>

          <Card className="p-5">
            <CardHeader title="AI Drafts Awaiting Approval" action={<PanelButton href="/outbound">View all</PanelButton>} />
            <p className="mt-2 text-xs text-slate-500">Drafts generated from top opportunities. Nothing sends automatically.</p>
            {targetsLoading ? (
              <p className="mt-4 text-sm font-medium shimmer-text">Loading drafts...</p>
            ) : draftTargets.length === 0 ? (
              <EmptyState title="No drafts waiting" copy="Drafts appear after opportunities have a recommended message. Nothing sends automatically." />
            ) : (
              <div className="mt-4 space-y-3">
                {draftTargets.map((target) => (
                  <div key={target.id} className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[1fr_auto]">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-950">{(target.recommendedCampaign ?? "").trim() || target.playbook}</p>
                      <p className="mt-1 line-clamp-1 text-xs text-slate-600">{concisePreview(target.recommendedMessage)}</p>
                    </div>
                    <PanelButton href={targetDraftHref(target)}>Review</PanelButton>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <CardHeader title="Campaign Readiness" action={<PanelButton href="/opportunities">View all</PanelButton>} />
            <div className="mt-4 space-y-3">
              {playbooksError ? (
                <InlineError message="Unable to load campaign readiness." onRetry={() => void loadPlaybooks("full")} />
              ) : playbooksLoading ? (
                <p className="text-sm font-medium shimmer-text">Loading campaigns...</p>
              ) : campaignBoard.length === 0 ? (
                <EmptyState title="No campaign readiness yet" copy="Campaign performance will appear after outreach launches. Until then, this panel uses real playbook readiness only." />
              ) : (
                campaignBoard.map((playbook) => (
                  <Link key={playbook.id} href={playbookHref(playbook.campaignName)} className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 transition hover:bg-slate-100">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-950">{playbook.campaignName}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {playbook.targetCount} targets · {playbook.qualifiedLeadCount} qualified · {playbook.knownPipelineCents > 0 ? `${formatCurrency(playbook.knownPipelineCents / 100)} known` : `${playbook.revenueTbdCount} revenue TBD`}
                      </p>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${priorityClass(playbook.urgency)}`}>
                      {labelize(playbook.urgency)}
                    </span>
                  </Link>
                ))
              )}
            </div>
          </Card>
        </div>
      </section>

      <section className="mt-5">
        <Card className="p-5">
          <CardHeader title="Operator Focus" eyebrow={businessName} />
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <FocusItem
              label="Do first"
              value={bestPlaybook?.campaignName ?? "Review opportunity queue"}
              copy={bestPlaybook ? firstSentence(bestPlaybook.strategicReason, 120) : "No top playbook is available yet."}
            />
            <FocusItem
              label="Money likely"
              value={knownPipelineCents > 0 ? formatCurrency(knownPipelineCents / 100) : "Revenue TBD"}
              copy="Known pipeline excludes weak or unpriced opportunities."
            />
            <FocusItem
              label="Needs review"
              value={`${revenue?.revenueTbdCount ?? 0} TBD · ${revenue?.reviewOnlyCount ?? 0} review-only`}
              copy="Set firm offer amounts before counting unpriced plays as pipeline."
            />
          </div>
        </Card>
      </section>
    </div>
  );
}

function Metric({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className={`mt-2 text-lg font-semibold tracking-[-0.03em] ${accent ? "text-emerald-900" : "text-slate-950"}`}>{value}</p>
    </div>
  );
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-xs leading-5 text-slate-500">{copy}</p>
    </div>
  );
}

function InlineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4">
      <p className="text-sm font-semibold text-red-700">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-full border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100"
      >
        Retry
      </button>
    </div>
  );
}

function FocusItem({ label, value, copy }: { label: string; value: string; copy: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700/60">{label}</p>
      <p className="mt-2 text-base font-semibold tracking-[-0.03em] text-slate-950">{value}</p>
      <p className="mt-2 text-xs leading-5 text-slate-500">{copy}</p>
    </div>
  );
}
