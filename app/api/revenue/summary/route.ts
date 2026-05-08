import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../lib/require-auth";
import {
  buildPublicRevenueSummaryPayload,
  getReportingRangeLa,
  loadPipelineHonestyAggregate,
  loadRevenueEventsMonthAggregate,
  loadRevenueViewRowForSlug,
  resolveReportingMonthKey,
  type RevenueSummaryDiagnostics,
} from "../../lib/revenue-summary";
import { BUSINESS_ID, BUSINESS_NAME, BUSINESS_SLUG } from "../../config";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}

function jsonNoStore(body: unknown) {
  return NextResponse.json(body, { headers: NO_STORE_HEADERS });
}

function emptyDiagnostics(): RevenueSummaryDiagnostics {
  const monthKey = resolveReportingMonthKey();
  const range = getReportingRangeLa(monthKey);
  return {
    reportingMonth: range.reportingMonth,
    reportingStart: range.reportingStart,
    reportingEnd: range.reportingEnd,
    generatedAt: new Date().toISOString(),
    revenueSource: "revenue_events_live",
    latestRevenueEventAt: null,
    latestRevenueInsertedAt: null,
    revenueEventCount: 0,
    openOpportunityCount: 0,
    knownPipelineCents: 0,
    qualifiedLeadCount: 0,
    revenueTbdCount: 0,
    reviewOnlyCount: 0,
    pipelineCoveragePercent: 0,
  };
}

export async function GET() {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  const supabase = getSupabaseAdmin();

  try {
    const monthKey = resolveReportingMonthKey();
    const range = getReportingRangeLa(monthKey);
    const generatedAt = new Date().toISOString();

    const [{ row, goalStatus }, pipeline, agg] = await Promise.all([
      loadRevenueViewRowForSlug(supabase, BUSINESS_SLUG),
      loadPipelineHonestyAggregate(supabase, BUSINESS_ID),
      loadRevenueEventsMonthAggregate(
        supabase,
        BUSINESS_ID,
        range.reportingStart,
        range.reportingEnd
      ),
    ]);

    const diagnostics: RevenueSummaryDiagnostics = {
      reportingMonth: range.reportingMonth,
      reportingStart: range.reportingStart,
      reportingEnd: range.reportingEnd,
      generatedAt,
      revenueSource: "revenue_events_live",
      latestRevenueEventAt: agg.latestOccurredAt,
      latestRevenueInsertedAt: agg.latestInsertedAt,
      revenueEventCount: agg.count,
      openOpportunityCount: pipeline.openOpportunityCount,
      knownPipelineCents: pipeline.knownPipelineCents,
      qualifiedLeadCount: pipeline.qualifiedLeadCount,
      revenueTbdCount: pipeline.revenueTbdCount,
      reviewOnlyCount: pipeline.reviewOnlyCount,
      pipelineCoveragePercent: 0,
    };

    const payload = buildPublicRevenueSummaryPayload({
      row,
      goalStatus,
      liveActualRevenueCents: agg.sumCents,
      fallbackBusinessId: BUSINESS_ID,
      fallbackBusinessName: BUSINESS_NAME,
      fallbackBusinessSlug: BUSINESS_SLUG,
      diagnostics,
    });

    return jsonNoStore(payload);
  } catch (error) {
    console.error("revenue summary fallback", error);
    return jsonNoStore(
      buildPublicRevenueSummaryPayload({
        row: null,
        goalStatus: "missing",
        liveActualRevenueCents: 0,
        fallbackBusinessId: BUSINESS_ID,
        fallbackBusinessName: BUSINESS_NAME,
        fallbackBusinessSlug: BUSINESS_SLUG,
        diagnostics: emptyDiagnostics(),
      })
    );
  }
}
