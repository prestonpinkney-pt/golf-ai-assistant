import "server-only";

import { DateTime } from "luxon";

import {
  classifySimulatorPricingTier,
  estimateSimulatorHourlyRatesUsd,
} from "@/lib/primetime/pricing";
import { PRIMETIME_BUSINESS_TIMEZONE } from "@/lib/whoosh/opportunities";

/**
 * Priced simulator rental in cents (USD) from Primetime tiers + slot instant.
 */
export function estimateSimulatorBookingUsdCents(params: {
  partySize: number;
  durationMinutes: number;
  slotStartIso: string;
}): number {
  const dt = DateTime.fromISO(params.slotStartIso, { setZone: true });
  if (!dt.isValid)
    throw new Error(`estimateSimulatorBookingUsdCents: invalid ISO ${params.slotStartIso}`);
  const local = dt.setZone(PRIMETIME_BUSINESS_TIMEZONE);
  const tier = classifySimulatorPricingTier(local);
  const rates = estimateSimulatorHourlyRatesUsd({
    partySize: Math.max(1, Math.round(params.partySize)),
    tier,
  });
  const ps = Math.max(1, Math.round(params.partySize));
  const hourly =
    ps <= 1 ? rates.soloPerHour ?? null
    : rates.groupPerHour ?? rates.soloPerHour ?? null;
  if (hourly === null || !rates.tier) {
    throw new Error(
      "estimateSimulatorBookingUsdCents: could not classify pricing tier for simulator slot."
    );
  }
  const hours = Math.max(1 / 60, Math.max(1, Math.round(params.durationMinutes)) / 60);
  return Math.round(hourly * hours * 100);
}
