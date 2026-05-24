import {
  assignRecoverySegment,
  daysSinceLastVisit,
  isExcludedFromRecovery,
  MIN_HIGH_VALUE_SPEND_CENTS,
  SPEND_LOOKBACK_DAYS,
} from "./segments";
import type { RevenueRecoveryCampaignStatus } from "./types";
import {
  normalizeSquarePhone,
  resolveSquareCustomerIdentity,
} from "@/lib/square/customer-identity";

export type RecoveryProfileInput = {
  source?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  raw_payload?: unknown;
  total_spend_cents?: number | null;
  last_purchase_at?: string | null;
  exclude_from_ai_targeting?: boolean | null;
  sms_opt_out?: boolean;
  campaign_status?: RevenueRecoveryCampaignStatus | string;
};

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

export function resolveProfileContact(profile: RecoveryProfileInput) {
  return resolveSquareCustomerIdentity({
    source: profile.source ?? "square",
    first_name: profile.first_name,
    last_name: profile.last_name,
    email: profile.email,
    phone: profile.phone,
    raw_payload: profile.raw_payload,
  });
}

export function isReachableByPhoneOrEmail(
  phone: string | null | undefined,
  email: string | null | undefined
): boolean {
  return Boolean(normalizeSquarePhone(phone) || nonEmpty(email));
}

/** SMS outreach requires a normalized phone. */
export function isTextableForSms(phone: string | null | undefined): boolean {
  return Boolean(normalizeSquarePhone(phone));
}

export type ReachabilityReport = {
  squareProfilesTotal: number;
  square130PlusTotal: number;
  square130PlusWithPhone: number;
  square130PlusWithEmail: number;
  square130PlusReachable: number;
  square130PlusMissingContactInfo: number;
  revenueRecoveryWarmInactiveCount: number;
  revenueRecoveryWarmInactiveTextableCount: number;
  recentlyActiveUpsellCount: number;
  recentlyActiveUpsellTextableCount: number;
  coldHighValueCount: number;
  coldHighValueTextableCount: number;
  revenueRecoveryMissingIdentityCount: number;
};

export function computeReachabilityReport(
  profiles: RecoveryProfileInput[],
  nowMs: number = Date.now()
): ReachabilityReport {
  const report: ReachabilityReport = {
    squareProfilesTotal: profiles.length,
    square130PlusTotal: 0,
    square130PlusWithPhone: 0,
    square130PlusWithEmail: 0,
    square130PlusReachable: 0,
    square130PlusMissingContactInfo: 0,
    revenueRecoveryWarmInactiveCount: 0,
    revenueRecoveryWarmInactiveTextableCount: 0,
    recentlyActiveUpsellCount: 0,
    recentlyActiveUpsellTextableCount: 0,
    coldHighValueCount: 0,
    coldHighValueTextableCount: 0,
    revenueRecoveryMissingIdentityCount: 0,
  };

  for (const row of profiles) {
    const resolved = resolveProfileContact(row);
    const phone = normalizeSquarePhone(resolved.phone);
    const email = nonEmpty(resolved.email) ? resolved.email!.trim() : null;

    const daysSinceVisit = daysSinceLastVisit(row.last_purchase_at, nowMs);
    const highValue =
      (row.total_spend_cents ?? 0) >= MIN_HIGH_VALUE_SPEND_CENTS &&
      daysSinceVisit !== null &&
      daysSinceVisit <= SPEND_LOOKBACK_DAYS;

    if (!highValue) continue;

    report.square130PlusTotal += 1;
    if (phone) report.square130PlusWithPhone += 1;
    if (email) report.square130PlusWithEmail += 1;

    const reachable = isReachableByPhoneOrEmail(phone, email);
    if (reachable) {
      report.square130PlusReachable += 1;
    } else {
      report.square130PlusMissingContactInfo += 1;
    }

    if (row.exclude_from_ai_targeting) continue;

    const segment = assignRecoverySegment({
      totalSpendCents: row.total_spend_cents ?? 0,
      lastVisitAt: row.last_purchase_at ?? null,
      nowMs,
    });

    if (!segment) continue;

    const excluded = isExcludedFromRecovery({
      totalSpendCents: row.total_spend_cents ?? 0,
      lastVisitAt: row.last_purchase_at ?? null,
      smsOptOut: Boolean(row.sms_opt_out),
      campaignStatus: row.campaign_status ?? "not_contacted",
      nowMs,
    });

    if (excluded) continue;

    if (segment === "warm_inactive_130_plus") {
      report.revenueRecoveryWarmInactiveCount += 1;
      if (isTextableForSms(phone)) {
        report.revenueRecoveryWarmInactiveTextableCount += 1;
      }
    }
    if (segment === "recently_active_upsell") {
      report.recentlyActiveUpsellCount += 1;
      if (isTextableForSms(phone)) {
        report.recentlyActiveUpsellTextableCount += 1;
      }
    }
    if (segment === "cold_high_value") {
      report.coldHighValueCount += 1;
      if (isTextableForSms(phone)) {
        report.coldHighValueTextableCount += 1;
      }
    }

    if (!reachable) {
      report.revenueRecoveryMissingIdentityCount += 1;
    }
  }

  return report;
}
