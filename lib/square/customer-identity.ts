/**
 * Square customer identity normalization for customer_profiles.
 * Fills blank columns from Square API fields or stored raw_payload without overwriting.
 */

export type SquareCustomerIdentityFields = {
  given_name?: string | null;
  family_name?: string | null;
  email_address?: string | null;
  phone_number?: string | null;
  company_name?: string | null;
};

export type CustomerProfileIdentityRow = {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  company_name?: string | null;
  identity_confidence?: number | null;
  identity_sources?: string[] | null;
  raw_payload?: unknown;
  source?: string | null;
};

export type ResolvedSquareIdentity = {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};

export type SquareIdentityPatchResult = {
  patch: Record<string, unknown>;
  enrichedFromRawPayload: boolean;
  filledFieldKeys: string[];
};

const SQUARE_RAW_SOURCE_TAG = "square_raw_payload";
export const SQUARE_CUSTOMER_DIRECTORY_TAG = "square_customer_directory";
export const SQUARE_DIRECTORY_IDENTITY_CONFIDENCE = 90;
export const SQUARE_RAW_PAYLOAD_IDENTITY_CONFIDENCE = 80;

function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  return t.length > 0 ? t : null;
}

/** Normalize US phone to E.164 when possible. */
export function normalizeSquarePhone(value: string | null | undefined): string | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  if (/^\+[1-9]\d{7,14}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read Square customer shape from raw_payload (top-level or nested `customer`). */
export function parseSquareIdentityFromRawPayload(
  raw: unknown
): SquareCustomerIdentityFields | null {
  if (!isRecord(raw)) return null;

  const hasTopLevel =
    "given_name" in raw ||
    "family_name" in raw ||
    "email_address" in raw ||
    "phone_number" in raw;

  const src = hasTopLevel
    ? raw
    : isRecord(raw.customer)
      ? raw.customer
      : null;

  if (!src) return null;

  return {
    given_name: nonEmpty(src.given_name as string | undefined),
    family_name: nonEmpty(src.family_name as string | undefined),
    email_address: nonEmpty(src.email_address as string | undefined),
    phone_number: nonEmpty(src.phone_number as string | undefined),
    company_name: nonEmpty(src.company_name as string | undefined),
  };
}

export function squareIdentityFromCustomer(
  customer: SquareCustomerIdentityFields | null | undefined
): SquareCustomerIdentityFields | null {
  if (!customer) return null;
  const parsed: SquareCustomerIdentityFields = {
    given_name: nonEmpty(customer.given_name),
    family_name: nonEmpty(customer.family_name),
    email_address: nonEmpty(customer.email_address),
    phone_number: nonEmpty(customer.phone_number),
    company_name: nonEmpty(customer.company_name),
  };
  if (
    !parsed.given_name &&
    !parsed.family_name &&
    !parsed.email_address &&
    !parsed.phone_number
  ) {
    return null;
  }
  return parsed;
}

export function mergeIdentitySources(
  existing: string[] | null | undefined,
  tag: string
): string[] {
  const base = Array.isArray(existing) ? [...existing] : [];
  if (!base.includes(tag)) base.push(tag);
  return base;
}

/** Resolved display identity: columns first, then raw_payload for source=square. */
export function resolveSquareCustomerIdentity(
  row: CustomerProfileIdentityRow
): ResolvedSquareIdentity {
  const fromColumns: ResolvedSquareIdentity = {
    first_name: nonEmpty(row.first_name),
    last_name: nonEmpty(row.last_name),
    email: nonEmpty(row.email),
    phone: normalizeSquarePhone(row.phone),
  };

  if (row.source !== "square") {
    return fromColumns;
  }

  const payload = parseSquareIdentityFromRawPayload(row.raw_payload);
  if (!payload) {
    return fromColumns;
  }

  return {
    first_name: fromColumns.first_name ?? nonEmpty(payload.given_name),
    last_name: fromColumns.last_name ?? nonEmpty(payload.family_name),
    email: fromColumns.email ?? nonEmpty(payload.email_address),
    phone: fromColumns.phone ?? normalizeSquarePhone(payload.phone_number),
  };
}

/**
 * Build UPDATE patch filling only empty identity fields from Square payload.
 * Sets identity_confidence >= 80 when email or phone is newly filled from raw_payload.
 */
type IdentityPatchOptions = {
  nowIso?: string;
  fromRawPayload?: boolean;
  sourceTag?: string;
  incomingConfidence?: number;
  allowOverwriteWhenHigherConfidence?: boolean;
};

function shouldApplyIdentityField(input: {
  existingValue: string | null | undefined;
  incomingValue: string | null | undefined;
  existingConfidence: number;
  incomingConfidence: number;
  allowOverwriteWhenHigherConfidence: boolean;
}): boolean {
  const incoming = nonEmpty(input.incomingValue);
  if (!incoming) return false;
  const existing = nonEmpty(input.existingValue);
  if (!existing) return true;
  if (!input.allowOverwriteWhenHigherConfidence) return false;
  return input.incomingConfidence > input.existingConfidence;
}

export function buildSquareIdentityPatch(
  existing: CustomerProfileIdentityRow,
  square: SquareCustomerIdentityFields | null | undefined,
  options?: IdentityPatchOptions
): SquareIdentityPatchResult {
  const nowIso = options?.nowIso ?? new Date().toISOString();
  const fromRawPayload = options?.fromRawPayload ?? false;
  const sourceTag =
    options?.sourceTag ??
    (fromRawPayload ? SQUARE_RAW_SOURCE_TAG : "square");
  const incomingConfidence =
    options?.incomingConfidence ??
    (fromRawPayload
      ? SQUARE_RAW_PAYLOAD_IDENTITY_CONFIDENCE
      : sourceTag === SQUARE_CUSTOMER_DIRECTORY_TAG
        ? SQUARE_DIRECTORY_IDENTITY_CONFIDENCE
        : 80);
  const allowOverwrite = options?.allowOverwriteWhenHigherConfidence ?? false;
  const existingConfidence = existing.identity_confidence ?? 0;
  const parsed = squareIdentityFromCustomer(square);

  const patch: Record<string, unknown> = {};
  const filledFieldKeys: string[] = [];

  if (!parsed) {
    return { patch, enrichedFromRawPayload: fromRawPayload, filledFieldKeys };
  }

  const fieldDefs: Array<{
    key: "first_name" | "last_name" | "email" | "phone";
    existing: string | null | undefined;
    incoming: string | null | undefined;
    apply: (v: string) => void;
  }> = [
    {
      key: "first_name",
      existing: existing.first_name,
      incoming: parsed.given_name,
      apply: (v) => {
        patch.first_name = v;
      },
    },
    {
      key: "last_name",
      existing: existing.last_name,
      incoming: parsed.family_name,
      apply: (v) => {
        patch.last_name = v;
      },
    },
    {
      key: "email",
      existing: existing.email,
      incoming: parsed.email_address,
      apply: (v) => {
        patch.email = v;
      },
    },
    {
      key: "phone",
      existing: existing.phone,
      incoming: normalizeSquarePhone(parsed.phone_number),
      apply: (v) => {
        patch.phone = v;
      },
    },
  ];

  for (const field of fieldDefs) {
    if (
      shouldApplyIdentityField({
        existingValue: field.existing,
        incomingValue: field.incoming,
        existingConfidence,
        incomingConfidence,
        allowOverwriteWhenHigherConfidence: allowOverwrite,
      }) &&
      field.incoming
    ) {
      field.apply(field.incoming);
      filledFieldKeys.push(field.key);
    }
  }

  if (parsed.company_name && !nonEmpty(existing.company_name as string | undefined)) {
    patch.company_name = parsed.company_name;
  }

  if (filledFieldKeys.length === 0) {
    return { patch, enrichedFromRawPayload: fromRawPayload, filledFieldKeys };
  }

  const filledEmailOrPhone =
    filledFieldKeys.includes("email") || filledFieldKeys.includes("phone");

  patch.identity_confidence = Math.max(existingConfidence, incomingConfidence);
  patch.identity_sources = mergeIdentitySources(existing.identity_sources, sourceTag);
  patch.last_identity_enriched_at = nowIso;
  patch.updated_at = nowIso;

  if (!filledEmailOrPhone && filledFieldKeys.length > 0) {
    // Name-only enrichment still records directory provenance.
    patch.identity_confidence = Math.max(existingConfidence, incomingConfidence);
  }

  return { patch, enrichedFromRawPayload: fromRawPayload, filledFieldKeys };
}

/** Square Customer Directory match by external_customer_id (confidence 90). */
export function buildSquareIdentityPatchFromDirectory(
  existing: CustomerProfileIdentityRow,
  square: SquareCustomerIdentityFields | null | undefined,
  nowIso?: string
): SquareIdentityPatchResult {
  return buildSquareIdentityPatch(existing, square, {
    nowIso,
    fromRawPayload: false,
    sourceTag: SQUARE_CUSTOMER_DIRECTORY_TAG,
    incomingConfidence: SQUARE_DIRECTORY_IDENTITY_CONFIDENCE,
    allowOverwriteWhenHigherConfidence: true,
  });
}

/** Upsert row for sync: always stores raw_payload; identity only when Square customer present. */
export function buildSquareCustomerProfileUpsertRow(input: {
  businessId: string;
  externalCustomerId: string;
  squareCustomer: SquareCustomerIdentityFields | null | undefined;
}): Record<string, unknown> {
  const nowIso = new Date().toISOString();
  const parsed = squareIdentityFromCustomer(input.squareCustomer);

  const row: Record<string, unknown> = {
    business_id: input.businessId,
    source: "square",
    external_customer_id: input.externalCustomerId,
    ai_segment: "unclassified",
    ai_score: 0,
    updated_at: nowIso,
  };

  if (input.squareCustomer && isRecord(input.squareCustomer as object)) {
    row.raw_payload = input.squareCustomer;
  } else if (parsed) {
    row.raw_payload = parsed;
  }

  if (parsed?.given_name) row.first_name = parsed.given_name;
  if (parsed?.family_name) row.last_name = parsed.family_name;
  if (parsed?.email_address) row.email = parsed.email_address;
  if (parsed?.phone_number) row.phone = normalizeSquarePhone(parsed.phone_number);

  if (parsed?.email_address || parsed?.phone_number) {
    row.identity_confidence = 80;
    row.identity_sources = ["square"];
    row.last_identity_enriched_at = nowIso;
  }

  return row;
}

/** Patch from stored raw_payload when columns are still empty. */
export function buildSquareIdentityPatchFromRawPayload(
  existing: CustomerProfileIdentityRow,
  nowIso?: string
): SquareIdentityPatchResult {
  const payload = parseSquareIdentityFromRawPayload(existing.raw_payload);
  return buildSquareIdentityPatch(existing, payload, {
    nowIso,
    fromRawPayload: true,
  });
}
