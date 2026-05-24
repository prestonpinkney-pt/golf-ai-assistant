import type { SupabaseClient } from "@supabase/supabase-js";
import {
  bulkRetrieveSquareCustomers,
  isSquareCustomerNotFoundError,
  listAllSquareCustomers,
  retrieveSquareCustomerById,
  sanitizeSquareCustomerPayload,
  type SquareCustomerRecord,
} from "./api";
import {
  buildSquareIdentityPatch,
  buildSquareIdentityPatchFromDirectory,
  buildSquareIdentityPatchFromRawPayload,
  normalizeSquarePhone,
  resolveSquareCustomerIdentity,
  type CustomerProfileIdentityRow,
} from "./customer-identity";
import {
  MIN_HIGH_VALUE_SPEND_CENTS,
  SPEND_LOOKBACK_DAYS,
  lastVisitWithinPastYear,
} from "@/lib/revenue-recovery/segments";

export type DirectorySyncStats = {
  fetchedCustomers: number;
  updatedProfiles: number;
  insertedProfiles: number;
  enrichedWithPhone: number;
  enrichedWithEmail: number;
  fallbackFetched: number;
  rawPayloadBackfilled: number;
  skippedNotFound: number;
  skippedNoExternalCustomerId: number;
  failedOtherErrors: number;
};

type ProfileRow = CustomerProfileIdentityRow & {
  id: string;
  external_customer_id: string | null;
  total_spend_cents: number | null;
  last_purchase_at: string | null;
  exclude_from_ai_targeting?: boolean | null;
};

function nonEmpty(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0;
}

function isReachable(phone: string | null, email: string | null): boolean {
  return Boolean(normalizeSquarePhone(phone) || nonEmpty(email));
}

/** Count high-value ($130+, 1yr) Square profiles reachable by phone or email. */
export function countHighValueReachable(
  profiles: Array<{
    total_spend_cents?: number | null;
    last_purchase_at?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
    raw_payload?: unknown;
    source?: string | null;
  }>,
  nowMs: number = Date.now()
): number {
  let count = 0;
  for (const row of profiles) {
    if ((row.total_spend_cents ?? 0) < MIN_HIGH_VALUE_SPEND_CENTS) continue;
    if (!lastVisitWithinPastYear(row.last_purchase_at, nowMs)) continue;
    const resolved = resolveSquareCustomerIdentity({
      source: row.source ?? "square",
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      phone: row.phone,
      raw_payload: row.raw_payload,
    });
    if (isReachable(resolved.phone, resolved.email)) count += 1;
  }
  return count;
}

export async function syncSquareCustomerDirectory(input: {
  supabase: SupabaseClient;
  businessId: string;
  accessToken: string;
  environment?: string;
}): Promise<DirectorySyncStats> {
  const stats: DirectorySyncStats = {
    fetchedCustomers: 0,
    updatedProfiles: 0,
    insertedProfiles: 0,
    enrichedWithPhone: 0,
    enrichedWithEmail: 0,
    fallbackFetched: 0,
    rawPayloadBackfilled: 0,
    skippedNotFound: 0,
    skippedNoExternalCustomerId: 0,
    failedOtherErrors: 0,
  };

  const customers = await listAllSquareCustomers(
    input.accessToken,
    input.environment
  );
  stats.fetchedCustomers = customers.length;

  const existingByExternalId = await loadExistingSquareProfiles(
    input.supabase,
    input.businessId
  );

  const nowIso = new Date().toISOString();

  for (const customer of customers) {
    const externalId = customer.id;
    const existing = existingByExternalId.get(externalId);
    const safePayload = sanitizeSquareCustomerPayload(customer);

    if (!existing) {
      const insertRow = buildInsertRowFromDirectory({
        businessId: input.businessId,
        externalCustomerId: externalId,
        customer,
        safePayload,
        nowIso,
      });

      const { data: inserted, error } = await input.supabase
        .from("customer_profiles")
        .insert(insertRow)
        .select("id")
        .single();

      if (!error && inserted) {
        stats.insertedProfiles += 1;
        existingByExternalId.set(externalId, {
          id: inserted.id as string,
          external_customer_id: externalId,
          first_name: insertRow.first_name as string | null,
          last_name: insertRow.last_name as string | null,
          email: insertRow.email as string | null,
          phone: insertRow.phone as string | null,
          identity_confidence: insertRow.identity_confidence as number,
          identity_sources: insertRow.identity_sources as string[],
          raw_payload: safePayload,
          source: "square",
          total_spend_cents: 0,
          last_purchase_at: null,
        });
        trackEnrichment(stats, insertRow.phone as string | null, insertRow.email as string | null);
      }
      continue;
    }

    const { patch, filledFieldKeys } = buildSquareIdentityPatchFromDirectory(
      {
        first_name: existing.first_name,
        last_name: existing.last_name,
        email: existing.email,
        phone: existing.phone,
        identity_confidence: existing.identity_confidence,
        identity_sources: existing.identity_sources,
        source: "square",
      },
      customer,
      nowIso
    );

    const updatePayload: Record<string, unknown> = {
      ...patch,
      raw_payload: safePayload,
      updated_at: nowIso,
    };

    const { error } = await input.supabase
      .from("customer_profiles")
      .update(updatePayload)
      .eq("id", existing.id);

    if (!error) {
      stats.updatedProfiles += 1;
      if (filledFieldKeys.includes("phone")) stats.enrichedWithPhone += 1;
      if (filledFieldKeys.includes("email")) stats.enrichedWithEmail += 1;
      mergeExisting(existing, patch, safePayload);
    }
  }

  const fallbackStats = await enrichMissingHighValueIdentity(input);
  stats.fallbackFetched = fallbackStats.fallbackFetched;
  stats.rawPayloadBackfilled = fallbackStats.rawPayloadBackfilled;
  stats.skippedNotFound = fallbackStats.skippedNotFound;
  stats.skippedNoExternalCustomerId = fallbackStats.skippedNoExternalCustomerId;
  stats.failedOtherErrors = fallbackStats.failedOtherErrors;
  stats.enrichedWithPhone += fallbackStats.enrichedWithPhone;
  stats.enrichedWithEmail += fallbackStats.enrichedWithEmail;
  stats.updatedProfiles += fallbackStats.updatedProfiles;

  return stats;
}

async function loadExistingSquareProfiles(
  supabase: SupabaseClient,
  businessId: string
): Promise<Map<string, ProfileRow>> {
  const map = new Map<string, ProfileRow>();
  const pageSize = 500;
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select(
        "id, external_customer_id, first_name, last_name, email, phone, identity_confidence, identity_sources, raw_payload, source, total_spend_cents, last_purchase_at, exclude_from_ai_targeting"
      )
      .eq("business_id", businessId)
      .eq("source", "square")
      .range(from, from + pageSize - 1);

    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ProfileRow[];
    for (const row of rows) {
      if (row.external_customer_id) {
        map.set(row.external_customer_id, row);
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return map;
}

function buildInsertRowFromDirectory(input: {
  businessId: string;
  externalCustomerId: string;
  customer: SquareCustomerRecord;
  safePayload: Record<string, unknown>;
  nowIso: string;
}): Record<string, unknown> {
  const { patch } = buildSquareIdentityPatchFromDirectory(
    {
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      identity_confidence: 0,
      identity_sources: [],
      source: "square",
    },
    input.customer,
    input.nowIso
  );

  return {
    business_id: input.businessId,
    source: "square",
    external_customer_id: input.externalCustomerId,
    ...patch,
    raw_payload: input.safePayload,
    ai_segment: "unclassified",
    ai_score: 0,
    total_spend_cents: 0,
    visit_count: 0,
  };
}

function mergeExisting(
  existing: ProfileRow,
  patch: Record<string, unknown>,
  rawPayload: Record<string, unknown>
) {
  if (typeof patch.first_name === "string") existing.first_name = patch.first_name;
  if (typeof patch.last_name === "string") existing.last_name = patch.last_name;
  if (typeof patch.email === "string") existing.email = patch.email;
  if (typeof patch.phone === "string") existing.phone = patch.phone;
  if (typeof patch.identity_confidence === "number") {
    existing.identity_confidence = patch.identity_confidence;
  }
  if (Array.isArray(patch.identity_sources)) {
    existing.identity_sources = patch.identity_sources as string[];
  }
  existing.raw_payload = rawPayload;
}

function trackEnrichment(
  stats: DirectorySyncStats,
  phone: string | null,
  email: string | null
) {
  if (normalizeSquarePhone(phone)) stats.enrichedWithPhone += 1;
  if (nonEmpty(email)) stats.enrichedWithEmail += 1;
}

/** Fetch by external_customer_id or backfill from raw_payload for $130+ gaps. */
export async function enrichMissingHighValueIdentity(input: {
  supabase: SupabaseClient;
  businessId: string;
  accessToken: string;
  environment?: string;
}): Promise<{
  updatedProfiles: number;
  enrichedWithPhone: number;
  enrichedWithEmail: number;
  fallbackFetched: number;
  rawPayloadBackfilled: number;
  skippedNotFound: number;
  skippedNoExternalCustomerId: number;
  failedOtherErrors: number;
}> {
  const result = {
    updatedProfiles: 0,
    enrichedWithPhone: 0,
    enrichedWithEmail: 0,
    fallbackFetched: 0,
    rawPayloadBackfilled: 0,
    skippedNotFound: 0,
    skippedNoExternalCustomerId: 0,
    failedOtherErrors: 0,
  };

  const lookbackIso = new Date(
    Date.now() - SPEND_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: rows, error } = await input.supabase
    .from("customer_profiles")
    .select(
      "id, external_customer_id, first_name, last_name, email, phone, identity_confidence, identity_sources, raw_payload, source, total_spend_cents, last_purchase_at"
    )
    .eq("business_id", input.businessId)
    .eq("source", "square")
    .gte("total_spend_cents", MIN_HIGH_VALUE_SPEND_CENTS)
    .gte("last_purchase_at", lookbackIso);

  if (error) throw new Error(error.message);

  const profiles = (rows ?? []) as ProfileRow[];
  const needsApiFetch: string[] = [];

  for (const row of profiles) {
    const resolved = resolveSquareCustomerIdentity(row);
    if (isReachable(resolved.phone, resolved.email)) continue;

    const { patch, filledFieldKeys } = buildSquareIdentityPatchFromRawPayload(row);
    if (filledFieldKeys.length > 0) {
      const { error: upErr } = await input.supabase
        .from("customer_profiles")
        .update(patch)
        .eq("id", row.id);
      if (!upErr) {
        result.rawPayloadBackfilled += 1;
        result.updatedProfiles += 1;
        if (filledFieldKeys.includes("phone")) result.enrichedWithPhone += 1;
        if (filledFieldKeys.includes("email")) result.enrichedWithEmail += 1;
      }
      continue;
    }

    if (nonEmpty(row.external_customer_id)) needsApiFetch.push(row.external_customer_id!);
    else result.skippedNoExternalCustomerId += 1;
  }

  if (needsApiFetch.length === 0) return result;

  const squareById = await bulkRetrieveSquareCustomers(
    input.accessToken,
    [...new Set(needsApiFetch)],
    input.environment
  );

  for (const externalId of needsApiFetch) {
    const customer = squareById.get(externalId);
    if (!customer) {
      let single: SquareCustomerRecord | null = null;
      try {
        single = await retrieveSquareCustomerById(
          input.accessToken,
          externalId,
          input.environment
        );
      } catch (err) {
        if (isSquareCustomerNotFoundError(err)) {
          result.skippedNotFound += 1;
          await markSquareCustomerNotFound(input.supabase, profiles, externalId);
          continue;
        }
        result.failedOtherErrors += 1;
        throw err;
      }
      if (!single) continue;
      result.fallbackFetched += 1;
      await applyDirectoryPatch(input.supabase, profiles, externalId, single, result);
      continue;
    }

    result.fallbackFetched += 1;
    await applyDirectoryPatch(input.supabase, profiles, externalId, customer, result);
  }

  return result;
}

async function markSquareCustomerNotFound(
  supabase: SupabaseClient,
  profiles: ProfileRow[],
  externalId: string
) {
  const nowIso = new Date().toISOString();
  const affected = profiles.filter((p) => p.external_customer_id === externalId);
  for (const row of affected) {
    const rawPayload =
      row.raw_payload !== null &&
      typeof row.raw_payload === "object" &&
      !Array.isArray(row.raw_payload) ?
        (row.raw_payload as Record<string, unknown>)
      : {};
    const identitySources = Array.from(
      new Set([...(row.identity_sources ?? []), "square_customer_directory_not_found"])
    );
    const updatePayload = {
      identity_confidence: Math.min(row.identity_confidence ?? 0, 0),
      identity_sources: identitySources,
      raw_payload: {
        ...rawPayload,
        identity_enrichment_error: {
          kind: "square_customer_not_found",
          external_customer_id: externalId,
          checked_at: nowIso,
        },
      },
      last_identity_enriched_at: nowIso,
      updated_at: nowIso,
    };

    const { error } = await supabase
      .from("customer_profiles")
      .update(updatePayload)
      .eq("id", row.id);
    if (!error) {
      row.identity_confidence = 0;
      row.identity_sources = identitySources;
      row.raw_payload = updatePayload.raw_payload;
    }
  }
}

async function applyDirectoryPatch(
  supabase: SupabaseClient,
  profiles: ProfileRow[],
  externalId: string,
  customer: SquareCustomerRecord,
  result: {
    updatedProfiles: number;
    enrichedWithPhone: number;
    enrichedWithEmail: number;
  }
) {
  const row = profiles.find((p) => p.external_customer_id === externalId);
  if (!row) return;

  const { patch, filledFieldKeys } = buildSquareIdentityPatchFromDirectory(
    {
      first_name: row.first_name,
      last_name: row.last_name,
      email: row.email,
      phone: row.phone,
      identity_confidence: row.identity_confidence,
      identity_sources: row.identity_sources,
      source: "square",
    },
    customer
  );

  const updatePayload = {
    ...patch,
    raw_payload: sanitizeSquareCustomerPayload(customer),
  };

  if (Object.keys(updatePayload).length <= 1) return;

  const { error } = await supabase
    .from("customer_profiles")
    .update(updatePayload)
    .eq("id", row.id);

  if (error) return;

  result.updatedProfiles += 1;
  if (filledFieldKeys.includes("phone")) result.enrichedWithPhone += 1;
  if (filledFieldKeys.includes("email")) result.enrichedWithEmail += 1;
}
