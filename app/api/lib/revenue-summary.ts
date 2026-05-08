import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";
import {
  effectiveOpportunityTruth,
  knownPipelineDollarsFromTruth,
} from "./closeos-opportunity-truth";
import type { AdvisorRevenueSummary } from "./closeos-sales-advisor";

export type RevenueGoalStatus = "configured" | "missing" | "duplicate_resolved";

const REPORTING_TZ = "America/Los_Angeles";

type RevenueViewRow = {
  business_id: string;
  business_name: string;
  business_slug: string;
  monthly_goal_cents: number | null;
  actual_revenue_cents: number | null;
  remaining_gap_cents: number | null;
  goal_coverage_percent: number | null;
};

function num(v: number | null | undefined): number {
  if (v == null || Number.isNaN(Number(v))) return 0;
  return Number(v);
}

/**
 * CLOSEOS_REPORTING_MONTH is ignored on Vercel production unless
 * CLOSEOS_REPORTING_MONTH_DEBUG=1|true (explicit debugging).
 * Otherwise the current calendar month in America/Los_Angeles is used.
 */
function reportingMonthEnvOverrideAllowed(): boolean {
  const debug = process.env.CLOSEOS_REPORTING_MONTH_DEBUG?.trim().toLowerCase();
  if (debug === "1" || debug === "true" || debug === "yes") {
    return true;
  }
  return process.env.VERCEL_ENV !== "production";
}

/** YYYY-MM: env override (non-prod or debug) else current month in America/Los_Angeles. */
export function resolveReportingMonthKey(): string {
  const raw = process.env.CLOSEOS_REPORTING_MONTH?.trim();
  if (
    reportingMonthEnvOverrideAllowed() &&
    raw &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(raw)
  ) {
    return raw;
  }

  const now = DateTime.now().setZone(REPORTING_TZ);
  return `${now.year}-${String(now.month).padStart(2, "0")}`;
}

/**
 * First instant of `monthKey` in LA through first instant of the next month (exclusive end), as UTC ISO strings.
 */
export function getReportingRangeLa(monthKey: string): {
  reportingMonth: string;
  reportingStart: string;
  reportingEnd: string;
} {
  const [ys, ms] = monthKey.split("-");
  const y = parseInt(ys, 10);
  const mo = parseInt(ms, 10);
  if (!Number.isFinite(y) || mo < 1 || mo > 12) {
    throw new Error(`Invalid reporting month: ${monthKey}`);
  }

  const start = DateTime.fromObject({ year: y, month: mo, day: 1 }, { zone: REPORTING_TZ }).startOf("day");
  const end = start.plus({ months: 1 });

  return {
    reportingMonth: monthKey,
    reportingStart: start.toUTC().toISO()!,
    reportingEnd: end.toUTC().toISO()!,
  };
}

export type RevenueSummaryDiagnostics = {
  reportingMonth: string;
  reportingStart: string;
  reportingEnd: string;
  generatedAt: string;
  revenueSource: "revenue_events_live";
  latestRevenueEventAt: string | null;
  latestRevenueInsertedAt: string | null;
  revenueEventCount: number;
  openOpportunityCount: number;
  knownPipelineCents: number;
  qualifiedLeadCount: number;
  revenueTbdCount: number;
  reviewOnlyCount: number;
  pipelineCoveragePercent: number;
};

export type PipelineHonestyAggregate = {
  knownPipelineCents: number;
  qualifiedLeadCount: number;
  revenueTbdCount: number;
  reviewOnlyCount: number;
  openOpportunityCount: number;
};

/**
 * Loads at most one row from `revenue_summary_current_month` without `.single()`.
 * Used for monthly goal / display identity only — not for actual revenue.
 */
export async function loadRevenueViewRowForSlug(
  supabase: SupabaseClient,
  businessSlug: string
): Promise<{ row: RevenueViewRow | null; goalStatus: RevenueGoalStatus }> {
  const { data, error } = await supabase
    .from("revenue_summary_current_month")
    .select(
      `
      business_id,
      business_name,
      business_slug,
      monthly_goal_cents,
      actual_revenue_cents,
      remaining_gap_cents,
      goal_coverage_percent
    `
    )
    .eq("business_slug", businessSlug)
    .order("business_id", { ascending: true })
    .limit(2);

  if (error) {
    return { row: null, goalStatus: "missing" };
  }

  const rows = (data ?? []) as RevenueViewRow[];
  if (rows.length === 0) return { row: null, goalStatus: "missing" };
  if (rows.length > 1) return { row: rows[0] ?? null, goalStatus: "duplicate_resolved" };
  return { row: rows[0] ?? null, goalStatus: "configured" };
}

const REVENUE_PAGE_SIZE = 1000;

/**
 * Live aggregate from public.revenue_events — no database now().
 * Selects only amount_cents, occurred_at, created_at (no customer payload).
 */
export async function loadRevenueEventsMonthAggregate(
  supabase: SupabaseClient,
  businessId: string,
  reportingStart: string,
  reportingEnd: string
): Promise<{
  sumCents: number;
  count: number;
  latestOccurredAt: string | null;
  latestInsertedAt: string | null;
}> {
  let from = 0;
  let sumCents = 0;
  let count = 0;
  let latestOccurredAt: string | null = null;
  let latestInsertedAt: string | null = null;

  for (;;) {
    const to = from + REVENUE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("revenue_events")
      .select("amount_cents, occurred_at, created_at")
      .eq("business_id", businessId)
      .eq("status", "completed")
      .gte("occurred_at", reportingStart)
      .lt("occurred_at", reportingEnd)
      .order("occurred_at", { ascending: true })
      .range(from, to);

    if (error) {
      throw new Error(error.message);
    }

    const rows = data ?? [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const row = r as {
        amount_cents?: number;
        occurred_at?: string | null;
        created_at?: string | null;
      };
      sumCents += num(row.amount_cents);
      count += 1;
      const t = row.occurred_at;
      if (t && (!latestOccurredAt || t > latestOccurredAt)) {
        latestOccurredAt = t;
      }
      const c = row.created_at;
      if (c && (!latestInsertedAt || c > latestInsertedAt)) {
        latestInsertedAt = c;
      }
    }

    if (rows.length < REVENUE_PAGE_SIZE) break;
    from += REVENUE_PAGE_SIZE;
  }

  return {
    sumCents,
    count,
    latestOccurredAt,
    latestInsertedAt,
  };
}

const PIPELINE_PAGE_SIZE = 1000;

function isUsablePhoneForPipeline(phone: string | null): boolean {
  if (!phone) return false;
  const digitsOnly = phone.replace(/\D/g, "");
  if (digitsOnly.length === 10) return true;
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) return true;
  return false;
}

type CustomerProfileMini = {
  phone: string | null;
  exclude_from_ai_targeting: boolean | null;
};

type PipelineOppRow = {
  recognized_opportunity: string;
  estimated_revenue_cents: number | null;
  revenue_review_required?: boolean | null;
  counts_toward_pipeline?: boolean | null;
  offer_key?: string | null;
  pipeline_category?: string | null;
  source: string | null;
  customer_profiles: CustomerProfileMini | CustomerProfileMini[] | null;
};

function getCustomerMini(
  row: PipelineOppRow
): CustomerProfileMini | null {
  const cp = row.customer_profiles;
  if (Array.isArray(cp)) return cp[0] ?? null;
  return cp;
}

/**
 * Honest pipeline: only known_pipeline dollars for reachable, non-excluded customers.
 * Qualified leads / revenue TBD / review-only are counted separately (not as pipeline $).
 */
export async function loadPipelineHonestyAggregate(
  supabase: SupabaseClient,
  businessId: string
): Promise<PipelineHonestyAggregate> {
  const probe = await supabase
    .from("ai_opportunities")
    .select("pipeline_category")
    .eq("business_id", businessId)
    .limit(1);

  const selectCols =
    probe.error == null
      ? "recognized_opportunity,estimated_revenue_cents,revenue_review_required,counts_toward_pipeline,offer_key,pipeline_category,source,customer_profiles(phone,exclude_from_ai_targeting)"
      : "recognized_opportunity,estimated_revenue_cents,source,customer_profiles(phone,exclude_from_ai_targeting)";

  let from = 0;
  let knownPipelineCents = 0;
  let qualifiedLeadCount = 0;
  let revenueTbdCount = 0;
  let reviewOnlyCount = 0;
  let openOpportunityCount = 0;

  for (;;) {
    const to = from + PIPELINE_PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("ai_opportunities")
      .select(selectCols)
      .eq("business_id", businessId)
      .in("status", ["open", "queued"])
      .range(from, to);

    if (error) {
      throw new Error(error.message);
    }

    const rows = (data ?? []) as unknown as PipelineOppRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const customer = getCustomerMini(row);
      if (!customer) continue;
      if (customer.exclude_from_ai_targeting) continue;
      if (!isUsablePhoneForPipeline(customer.phone)) continue;

      const eff = effectiveOpportunityTruth({
        recognized_opportunity: row.recognized_opportunity,
        pipeline_category: row.pipeline_category ?? null,
        counts_toward_pipeline: row.counts_toward_pipeline ?? null,
        revenue_review_required: row.revenue_review_required ?? null,
        offer_key: row.offer_key ?? null,
        estimated_revenue_cents: row.estimated_revenue_cents,
      });

      if (eff.pipelineCategory === "data_quality") continue;

      openOpportunityCount += 1;
      knownPipelineCents += knownPipelineDollarsFromTruth(eff);

      if (eff.pipelineCategory === "qualified_lead") {
        qualifiedLeadCount += 1;
      }
      if (eff.pipelineCategory === "review_only") {
        reviewOnlyCount += 1;
      }
      if (eff.revenueReviewRequired) {
        revenueTbdCount += 1;
      }
    }

    if (rows.length < PIPELINE_PAGE_SIZE) break;
    from += PIPELINE_PAGE_SIZE;
  }

  return {
    knownPipelineCents,
    qualifiedLeadCount,
    revenueTbdCount,
    reviewOnlyCount,
    openOpportunityCount,
  };
}

export function buildAdvisorRevenueSummary(
  row: RevenueViewRow | null,
  liveActualCents: number,
  pipeline: PipelineHonestyAggregate | null = null,
  goalStatus: RevenueGoalStatus = "missing"
): AdvisorRevenueSummary | null {
  const monthlyGoalCents = row ? num(row.monthly_goal_cents) : 0;
  const actualRevenueCents = liveActualCents;

  if (!row && monthlyGoalCents === 0 && actualRevenueCents === 0) {
    return null;
  }

  const remainingGapCents = Math.max(0, monthlyGoalCents - actualRevenueCents);

  const goalCoveragePercent =
    monthlyGoalCents > 0
      ? Math.min(100, Math.round((actualRevenueCents / monthlyGoalCents) * 100))
      : row
        ? Math.min(100, Math.max(0, num(row.goal_coverage_percent)))
        : 0;

  return {
    monthlyGoalCents,
    actualRevenueCents,
    remainingGapCents,
    goalCoveragePercent,
    knownPipelineCents: pipeline?.knownPipelineCents ?? 0,
    qualifiedLeadCount: pipeline?.qualifiedLeadCount ?? 0,
    revenueTbdCount: pipeline?.revenueTbdCount ?? 0,
    reviewOnlyCount: pipeline?.reviewOnlyCount ?? 0,
    goalStatus,
  };
}

export type PublicRevenueSummaryPayload = {
  businessId: string;
  businessName: string;
  businessSlug: string;
  monthlyGoalCents: number;
  actualRevenueCents: number;
  remainingGapCents: number;
  /** @deprecated Prefer knownPipelineCents on diagnostics; kept equal for clients. */
  openPipelineCents: number;
  goalProgressPercent: number;
  goalCoveragePercent: number;
  goalStatus: RevenueGoalStatus;
} & RevenueSummaryDiagnostics;

export function buildPublicRevenueSummaryPayload(input: {
  row: RevenueViewRow | null;
  goalStatus: RevenueGoalStatus;
  liveActualRevenueCents: number;
  fallbackBusinessId: string;
  fallbackBusinessName: string;
  fallbackBusinessSlug: string;
  diagnostics: RevenueSummaryDiagnostics;
}): PublicRevenueSummaryPayload {
  const row = input.row;
  const monthlyGoalCents = row ? num(row.monthly_goal_cents) : 0;
  const actualRevenueCents = input.liveActualRevenueCents;
  const remainingGapCents = Math.max(0, monthlyGoalCents - actualRevenueCents);
  const knownPipelineCents = Math.max(0, input.diagnostics.knownPipelineCents);

  const goalProgressPercent =
    monthlyGoalCents > 0
      ? Math.min(100, Math.round((actualRevenueCents / monthlyGoalCents) * 100))
      : 0;

  const goalCoveragePercent = goalProgressPercent;

  const pipelineCoveragePercent =
    remainingGapCents > 0
      ? Math.min(
          100,
          Math.round((knownPipelineCents / remainingGapCents) * 100)
        )
      : knownPipelineCents > 0
        ? 100
        : 0;

  const mergedDiagnostics: RevenueSummaryDiagnostics = {
    ...input.diagnostics,
    knownPipelineCents,
    pipelineCoveragePercent,
  };

  return {
    businessId: row?.business_id ?? input.fallbackBusinessId,
    businessName: row?.business_name ?? input.fallbackBusinessName,
    businessSlug: row?.business_slug ?? input.fallbackBusinessSlug,
    monthlyGoalCents,
    actualRevenueCents,
    remainingGapCents,
    openPipelineCents: knownPipelineCents,
    goalProgressPercent,
    goalCoveragePercent,
    goalStatus: input.goalStatus,
    ...mergedDiagnostics,
  };
}
