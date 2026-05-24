import "server-only";

import { DateTime } from "luxon";

import {
  PRIMETIME_BUSINESS_TIMEZONE,
  isPublicBookableMoment,
} from "@/lib/whoosh/opportunities";

/**
 * Approved Primetime Golf (CloseOS SMS) simulator/bay tiers.
 * Lesson pricing is discrete session prices, not hourly.
 */
export const PRIMETIME_LOCATION_LINE = "Downtown Oakland";
export const PRIMETIME_WEBSITE = "primetimegolf.org";

export type SimulatorPricingTier = "off_peak_weekday" | "peak_weekend";

/** Pricing grid for SMS source-of-truth and estimates. Values in USD per hour unless noted as session prices. */
export const PRIMETIME_SIMULATOR_SOL_HOURLY_USD = {
  off_peak_weekday: 35,
  peak_weekend: 40,
} as const;

export const PRIMETIME_SIMULATOR_GROUP_HOURLY_USD = {
  /** Private bay rentals, 2+ players */
  off_peak_weekday: 70,
  peak_weekend: 80,
} as const;

export const PRIMETIME_LESSON_USD = {
  adult_30_session: 55,
  adult_60_session: 100,
  junior_60_session: 50,
} as const;

/**
 * Rough peak vs off-peak for pricing copy (SMS):
 * - Sat/Sun peak
 * - Fri all public hours peak
 * - Mon–Thu evenings (5 PM onwards) peak
 * Otherwise Mon–Thu before 5 PM PT: off-peak weekday.
 */
export function classifySimulatorPricingTier(d: DateTime | null): SimulatorPricingTier | null {
  if (!d || !d.isValid) return null;
  const dt = d.setZone(PRIMETIME_BUSINESS_TIMEZONE);
  const w = dt.weekday; // Luxon Mon=1
  if (w === 6 || w === 7) return "peak_weekend";

  const hour = dt.hour;
  if (w === 5) return hour >= 11 ? "peak_weekend" : "off_peak_weekday";

  if (w >= 1 && w <= 4) {
    return hour >= 17 ? "peak_weekend" : "off_peak_weekday";
  }

  return null;
}

export function estimateSimulatorHourlyRatesUsd(input: {
  partySize: number;
  tier: SimulatorPricingTier | null;
}): { soloPerHour?: number; groupPerHour?: number; tier: SimulatorPricingTier | null } {
  const tier = input.tier;
  const partySize = Math.max(1, Math.round(input.partySize));
  if (!tier)
    return { tier: null };

  const soloPerHour =
    tier === "off_peak_weekday"
      ? PRIMETIME_SIMULATOR_SOL_HOURLY_USD.off_peak_weekday
      : PRIMETIME_SIMULATOR_SOL_HOURLY_USD.peak_weekend;
  const groupPerHour =
    tier === "off_peak_weekday"
      ? PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.off_peak_weekday
      : PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.peak_weekend;

  if (partySize <= 1) {
    return { soloPerHour, tier };
  }

  return { groupPerHour, tier };
}

export function simulatorPricingSentence(): string {
  return [
    "Simulator/bay hourly (today’s tier depends on weekday vs weekend/time): ",
    `solo practice 1 player: $${PRIMETIME_SIMULATOR_SOL_HOURLY_USD.off_peak_weekday}/hr off-peak weekdays, $${PRIMETIME_SIMULATOR_SOL_HOURLY_USD.peak_weekend}/hr peak & weekends.`,
    ` Private bay rentals (2+ players): $${PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.off_peak_weekday}/hr off-peak weekdays, $${PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.peak_weekend}/hr peak & weekends.`,
  ].join("");
}

export function lessonPricingSentence(): string {
  return [
    `Lessons (session prices): Adult 30 minutes $${PRIMETIME_LESSON_USD.adult_30_session}, Adult 60 minutes $${PRIMETIME_LESSON_USD.adult_60_session}, Junior 60 minutes $${PRIMETIME_LESSON_USD.junior_60_session}.`,
  ].join("");
}

export function compactPricingSmsForBayQuestion(): string {
  return (
    `Solo practice runs $${PRIMETIME_SIMULATOR_SOL_HOURLY_USD.off_peak_weekday}/hr off-peak weekdays or $${PRIMETIME_SIMULATOR_SOL_HOURLY_USD.peak_weekend}/hr peak/weekends. ` +
    `For 2+ players private bay rentals are $${PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.off_peak_weekday}/hr off-peak or $${PRIMETIME_SIMULATOR_GROUP_HOURLY_USD.peak_weekend}/hr peak/weekends. (${PRIMETIME_LOCATION_LINE}; ${PRIMETIME_WEBSITE})`
  );
}

/** True when inbound likely asks about price/cost/how much alone (not requesting a slot). */
export function isLikelyStandalonePricingQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t || t.includes("availability") || t.includes("avail") || t.includes("slot")) return false;

  const hasPriceCue =
    /\b(how much|pricing|cost|rate|rates|hourly|charged|fee|fee's|fee is|price\b)/i.test(
      t
    );
  const hasBayCue =
    /\b(bay|bays|simulator|sim|sim time|practice session|solo|private bay|rent)/i.test(
      t
    );
  return hasPriceCue && (hasBayCue || /\b(lesson)\b/i.test(t));
}

export function isLikelyLessonPricingQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /\b(lesson)\b/i.test(t) && /\b(how much|pricing|cost|rate|fee|price)\b/i.test(t);
}

/**
 * Estimate price label for availability rows (SMS). Uses party size & slot start tier.
 */
export function formatEstimatedSimulatorPrice(params: {
  partySize: number;
  durationMinutes: number;
  slotStart: DateTime;
}): string {
  const tier = classifySimulatorPricingTier(params.slotStart);
  const rates = estimateSimulatorHourlyRatesUsd({
    partySize: params.partySize,
    tier,
  });
  const hours = Math.max(1 / 60, params.durationMinutes / 60);
  if (params.partySize <= 1 && rates.soloPerHour != null && tier)
    return `~${Math.round(rates.soloPerHour * hours)} USD (${tier.replaceAll("_", " ")})`;

  if (rates.groupPerHour != null && tier)
    return `~${Math.round(rates.groupPerHour * hours)} USD (${tier.replaceAll("_", " ")})`;

  if (rates.soloPerHour != null && tier)
    return `~${Math.round(rates.soloPerHour * hours)} USD (${tier.replaceAll("_", " ")})`;

  return "~see approved pricing tiers";
}

/**
 * Validates that a parsed slot sits in broadly bookable Primetime simulator public window when surfaced to non-members via SMS assumptions.
 */
export function isSlotEligibleForSmsPublicSimulator(slotLocal: DateTime): boolean {
  return isPublicBookableMoment(slotLocal);
}
