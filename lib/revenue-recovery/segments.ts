import type { RevenueRecoveryCampaignStatus, RevenueRecoverySegmentKey } from "./types";

/** Minimum lookback spend for high-value recovery ($130). */
export const MIN_HIGH_VALUE_SPEND_CENTS = 13000;
export const DEFAULT_SQUARE_SYNC_LOOKBACK_DAYS = 730;

export const WARM_INACTIVE_MIN_DAYS = 60;
export const WARM_INACTIVE_MAX_DAYS = 180;
export const RECENTLY_ACTIVE_MAX_DAYS = 30;
export const SPEND_LOOKBACK_DAYS = DEFAULT_SQUARE_SYNC_LOOKBACK_DAYS;

export type SegmentCandidateInput = {
  totalSpendCents: number;
  lastVisitAt: string | null;
  smsOptOut: boolean;
  campaignStatus: RevenueRecoveryCampaignStatus | string;
  nowMs?: number;
};

export function daysSinceLastVisit(
  lastVisitAt: string | null | undefined,
  nowMs: number = Date.now()
): number | null {
  if (!lastVisitAt) return null;
  const ms = Date.parse(lastVisitAt);
  if (Number.isNaN(ms)) return null;
  return Math.floor((nowMs - ms) / (24 * 60 * 60 * 1000));
}

export function lastVisitWithinPastYear(
  lastVisitAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const days = daysSinceLastVisit(lastVisitAt, nowMs);
  if (days === null) return false;
  return days <= SPEND_LOOKBACK_DAYS;
}

export function resolveSquareSyncLookbackDays(value?: string | number | null): number {
  const raw = value ?? process.env.SQUARE_SYNC_LOOKBACK_DAYS;
  const parsed =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SQUARE_SYNC_LOOKBACK_DAYS;
  return Math.min(Math.floor(parsed), 3650);
}

export function assignRecoverySegment(
  input: Pick<SegmentCandidateInput, "totalSpendCents" | "lastVisitAt"> & {
    nowMs?: number;
  }
): RevenueRecoverySegmentKey | null {
  const nowMs = input.nowMs ?? Date.now();
  const days = daysSinceLastVisit(input.lastVisitAt, nowMs);

  if (input.totalSpendCents < MIN_HIGH_VALUE_SPEND_CENTS) return null;
  if (days === null) return null;
  if (!lastVisitWithinPastYear(input.lastVisitAt, nowMs)) return null;

  if (days >= WARM_INACTIVE_MIN_DAYS && days <= WARM_INACTIVE_MAX_DAYS) {
    return "warm_inactive_130_plus";
  }
  if (days < RECENTLY_ACTIVE_MAX_DAYS) {
    return "recently_active_upsell";
  }
  if (days > WARM_INACTIVE_MAX_DAYS) {
    return "cold_high_value";
  }

  return null;
}

export function isExcludedFromRecovery(input: SegmentCandidateInput): boolean {
  if (input.smsOptOut) return true;
  if (input.campaignStatus === "do_not_contact") return true;
  return false;
}

export function isEligibleRecoveryCandidate(input: SegmentCandidateInput): boolean {
  if (isExcludedFromRecovery(input)) return false;
  return assignRecoverySegment(input) !== null;
}
