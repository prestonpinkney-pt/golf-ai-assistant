import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createWhooshCustomerProfile,
  normalizeWhooshEmail,
  normalizeWhooshPhone,
  parseWhooshCustomerType,
} from "./whoosh-import";

const LESSON_PAREN_RE = /^\s*Lesson\s*\(([^)]+)\)/i;

export type LessonParenParse =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "named"; name: string };

/**
 * Parses `Lesson (Name)` titles. "Unknown Customer" is treated as unknown (no Whoosh name match).
 */
export function parseLessonParenTitle(title: string): LessonParenParse {
  const m = (title ?? "").match(LESSON_PAREN_RE);
  if (!m?.[1]) return { kind: "none" };
  const inner = m[1].trim();
  if (!inner) return { kind: "none" };
  if (inner.toLowerCase() === "unknown customer") return { kind: "unknown" };
  return { kind: "named", name: inner };
}

export function isParenLessonCalendarTitle(title: string | null | undefined) {
  return /^\s*Lesson\s*\(/i.test(title ?? "");
}

/**
 * Lower-case, trim, collapse spaces, strip punctuation for 1:1 Whoosh full_name matching.
 */
export function normalizePersonNameForMatch(name: string) {
  return (name ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Google Calendar attendee / admin identities — never use as booking customer_email. */
export function isInternalOrAdminCalendarEmail(
  email: string | null | undefined
) {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return false;

  if (e === "primetimegolfoakland@gmail.com") return true;
  if (e.endsWith("@thepinkneyfoundation.org")) return true;

  const at = e.lastIndexOf("@");
  const host = at >= 0 ? e.slice(at + 1) : "";
  if (host.includes("whoosh") || host.includes("cronofy")) return true;

  return false;
}

export function coercePublicCustomerEmail(email: string | null | undefined) {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  if (isInternalOrAdminCalendarEmail(trimmed)) return null;
  return trimmed;
}

export type WhooshNameIndexRow = {
  id: string;
  external_id: string;
  full_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  matched_customer_profile_id: string | null;
  customer_type: string | null;
  is_member: boolean;
};

export function displayFullNameFromWhoosh(row: WhooshNameIndexRow) {
  const fn = row.full_name?.trim();
  if (fn) return fn;
  return [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
}

/** Same normalized roster name may appear on multiple rows; collapse by email / phone / matched profile. */
export type WhooshNameGroupIdentity =
  | { kind: "ambiguous" }
  | { kind: "no_identity" }
  | {
      kind: "unified";
      email: string | null;
      phone: string | null;
      matchedCustomerProfileId: string | null;
    };

export function collapseWhooshRowsByIdentity(
  rows: WhooshNameIndexRow[]
): WhooshNameGroupIdentity {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const profiles = new Set<string>();

  for (const r of rows) {
    const e = normalizeWhooshEmail(r.email);
    if (e) emails.add(e);
    const p = normalizeWhooshPhone(r.phone);
    if (p) phones.add(p);
    if (r.matched_customer_profile_id) {
      profiles.add(r.matched_customer_profile_id);
    }
  }

  if (emails.size > 1 || phones.size > 1 || profiles.size > 1) {
    return { kind: "ambiguous" };
  }

  const email = emails.size === 1 ? [...emails][0]! : null;
  const phone = phones.size === 1 ? [...phones][0]! : null;
  const matchedCustomerProfileId =
    profiles.size === 1 ? [...profiles][0]! : null;

  if (!email && !phone && !matchedCustomerProfileId) {
    return { kind: "no_identity" };
  }

  return { kind: "unified", email, phone, matchedCustomerProfileId };
}

function pickBestWhooshRowForGroup(rows: WhooshNameIndexRow[]) {
  const withProfile = rows.find((r) => r.matched_customer_profile_id);
  if (withProfile) return withProfile;
  const withBoth = rows.find(
    (r) => normalizeWhooshEmail(r.email) && normalizeWhooshPhone(r.phone)
  );
  if (withBoth) return withBoth;
  const withEmail = rows.find((r) => normalizeWhooshEmail(r.email));
  if (withEmail) return withEmail;
  const withPhone = rows.find((r) => normalizeWhooshPhone(r.phone));
  if (withPhone) return withPhone;
  return rows[0]!;
}

async function assignMatchedCustomerToWhooshRows(input: {
  supabase: SupabaseClient;
  businessId: string;
  rowIds: string[];
  customerProfileId: string;
  matchMethod: string;
  matchConfidence: number;
}) {
  const {
    supabase,
    businessId,
    rowIds,
    customerProfileId,
    matchMethod,
    matchConfidence,
  } = input;

  if (rowIds.length === 0) return;

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("whoosh_profiles")
    .update({
      matched_customer_profile_id: customerProfileId,
      match_method: matchMethod,
      match_confidence: matchConfidence,
      updated_at: now,
    })
    .eq("business_id", businessId)
    .in("id", rowIds);

  if (error) throw new Error(error.message);
}

type UnifiedWhooshIdentity = Extract<WhooshNameGroupIdentity, { kind: "unified" }>;

async function enrichContactFromCustomerProfile(input: {
  supabase: SupabaseClient;
  businessId: string;
  customerProfileId: string;
  email: string | null;
  phone: string | null;
}) {
  if (input.email || input.phone) {
    return { email: input.email, phone: input.phone };
  }

  const { data, error } = await input.supabase
    .from("customer_profiles")
    .select("email, phone")
    .eq("id", input.customerProfileId)
    .eq("business_id", input.businessId)
    .maybeSingle();

  if (error || !data) {
    return { email: null, phone: null };
  }

  const row = data as { email: string | null; phone: string | null };
  return {
    email: normalizeWhooshEmail(row.email),
    phone: normalizeWhooshPhone(row.phone),
  };
}

async function applyUnifiedWhooshLessonIdentity(input: {
  supabase: SupabaseClient;
  businessId: string;
  candidates: WhooshNameIndexRow[];
  parsedTitleName: string;
  identity: UnifiedWhooshIdentity;
}) {
  const { supabase, businessId, candidates, parsedTitleName, identity } = input;

  const best = pickBestWhooshRowForGroup(candidates);
  const displayName = displayFullNameFromWhoosh(best) || parsedTitleName;
  const rowIds = candidates.map((r) => r.id);
  const matchMethod = "calendar_lesson_unified";

  let customerProfileId: string | null = null;

  if (identity.matchedCustomerProfileId) {
    customerProfileId = identity.matchedCustomerProfileId;
    await assignMatchedCustomerToWhooshRows({
      supabase,
      businessId,
      rowIds,
      customerProfileId,
      matchMethod,
      matchConfidence: 95,
    });
  } else {
    const email =
      identity.email ?? normalizeWhooshEmail(best.email);
    const phone =
      identity.phone ?? normalizeWhooshPhone(best.phone);

    if (!email && !phone) {
      return {
        customerName: displayName,
        customerEmail: null,
        customerPhone: null,
        customerProfileId: null,
      };
    }

    const { isMember } = parseWhooshCustomerType(best.customer_type ?? "");
    let id: string;
    try {
      id = await createWhooshCustomerProfile({
        supabase,
        businessId,
        externalId: best.external_id,
        whoosh: {
          firstName: best.first_name ?? "",
          lastName: best.last_name ?? "",
          email,
          phone,
          isMember,
        },
        confidence: email && phone ? 85 : email ? 75 : 70,
      });
    } catch {
      return {
        customerName: displayName,
        customerEmail: email,
        customerPhone: phone,
        customerProfileId: null,
      };
    }

    customerProfileId = id;
    await assignMatchedCustomerToWhooshRows({
      supabase,
      businessId,
      rowIds,
      customerProfileId,
      matchMethod,
      matchConfidence: 88,
    });
  }

  let customerEmail = identity.email;
  let customerPhone = identity.phone;

  if (customerProfileId) {
    const enriched = await enrichContactFromCustomerProfile({
      supabase,
      businessId,
      customerProfileId,
      email: customerEmail,
      phone: customerPhone,
    });
    customerEmail = enriched.email ?? customerEmail;
    customerPhone = enriched.phone ?? customerPhone;
  }

  for (const r of candidates) {
    r.matched_customer_profile_id = customerProfileId;
  }

  return {
    customerName: displayName,
    customerEmail,
    customerPhone,
    customerProfileId,
  };
}

export async function loadWhooshNameIndex(
  supabase: SupabaseClient,
  businessId: string
) {
  const { data, error } = await supabase
    .from("whoosh_profiles")
    .select(
      "id, external_id, full_name, first_name, last_name, email, phone, matched_customer_profile_id, customer_type, is_member"
    )
    .eq("business_id", businessId)
    .eq("source", "whoosh_roster");

  if (error) throw new Error(error.message);

  const map = new Map<string, WhooshNameIndexRow[]>();
  for (const raw of data ?? []) {
    const row = raw as WhooshNameIndexRow;
    const display = displayFullNameFromWhoosh(row);
    const key = normalizePersonNameForMatch(display);
    if (!key) continue;
    const list = map.get(key) ?? [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

export type LessonWhooshResolution = {
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerProfileId: string | null;
  whooshCandidateCount: number;
};

export async function resolveLessonBookingIdentity(input: {
  supabase: SupabaseClient;
  businessId: string;
  title: string;
  nameIndex: Map<string, WhooshNameIndexRow[]>;
}): Promise<LessonWhooshResolution> {
  const { supabase, businessId, title, nameIndex } = input;

  const parse = parseLessonParenTitle(title);

  if (parse.kind === "none") {
    return {
      customerName: null,
      customerEmail: null,
      customerPhone: null,
      customerProfileId: null,
      whooshCandidateCount: 0,
    };
  }

  if (parse.kind === "unknown") {
    return {
      customerName: "Unknown Customer",
      customerEmail: null,
      customerPhone: null,
      customerProfileId: null,
      whooshCandidateCount: 0,
    };
  }

  const key = normalizePersonNameForMatch(parse.name);
  const candidates = key ? (nameIndex.get(key) ?? []) : [];

  if (candidates.length === 0) {
    return {
      customerName: parse.name,
      customerEmail: null,
      customerPhone: null,
      customerProfileId: null,
      whooshCandidateCount: 0,
    };
  }

  const identity = collapseWhooshRowsByIdentity(candidates);
  if (identity.kind === "ambiguous" || identity.kind === "no_identity") {
    return {
      customerName: parse.name,
      customerEmail: null,
      customerPhone: null,
      customerProfileId: null,
      whooshCandidateCount: candidates.length,
    };
  }

  const resolved = await applyUnifiedWhooshLessonIdentity({
    supabase,
    businessId,
    candidates,
    parsedTitleName: parse.name,
    identity,
  });

  return {
    customerName: resolved.customerName,
    customerEmail: resolved.customerEmail,
    customerPhone: resolved.customerPhone,
    customerProfileId: resolved.customerProfileId,
    whooshCandidateCount: candidates.length,
  };
}
