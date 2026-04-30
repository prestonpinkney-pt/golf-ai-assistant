import type { SupabaseClient } from "@supabase/supabase-js";

export type WhooshCsvRow = {
  firstName: string;
  lastName: string;
  customerType: string;
  dateOfBirth: string;
  email: string | null;
  phone: string | null;
  lineIndex: number;
};

export function normalizeWhooshEmail(value: string | null | undefined) {
  if (!value) return null;
  const s = value.trim().toLowerCase();
  return s.length ? s : null;
}

export function normalizeWhooshPhone(value: string | null | undefined) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function parseWhooshCustomerType(customerType: string) {
  const raw = (customerType ?? "").trim();
  const lower = raw.toLowerCase();
  const isMember = lower !== "" && lower !== "non-member";
  return {
    customerType: raw || null,
    isMember,
    membershipName: isMember ? raw : null,
  };
}

/** Minimal RFC4180-style CSV parser (quoted fields, commas, newlines). */
export function parseCsvToMatrix(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushRow = () => {
    row.push(field);
    field = "";
    if (row.some((c) => c.trim().length > 0)) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += c;
    }
  }

  row.push(field);
  if (row.some((c) => c.trim().length > 0)) {
    rows.push(row);
  }

  return rows;
}

export function matrixToWhooshRows(matrix: string[][]): WhooshCsvRow[] {
  if (matrix.length < 2) return [];

  const header = matrix[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.findIndex((h) => h === name.toLowerCase());

  const iFirst = idx("first name");
  const iLast = idx("last name");
  const iType = idx("customer type");
  const iDob = idx("date of birth");
  const iEmail = idx("email");
  const iPhone = idx("phone number");

  if (iType < 0 || iEmail < 0 || iPhone < 0) {
    throw new Error(
      "CSV must include headers: Customer Type, Email, Phone Number (and preferably First Name, Last Name, Date of Birth)"
    );
  }

  const out: WhooshCsvRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const line = matrix[r]!;
    const firstName = iFirst >= 0 ? (line[iFirst] ?? "").trim() : "";
    const lastName = iLast >= 0 ? (line[iLast] ?? "").trim() : "";
    out.push({
      firstName,
      lastName,
      customerType: (line[iType] ?? "").trim(),
      dateOfBirth: iDob >= 0 ? (line[iDob] ?? "").trim() : "",
      email: normalizeWhooshEmail(line[iEmail] ?? ""),
      phone: normalizeWhooshPhone(line[iPhone] ?? ""),
      lineIndex: r + 1,
    });
  }
  return out;
}

type CustomerLite = {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  is_member: boolean | null;
};

export function buildCustomerIndexes(rows: CustomerLite[]) {
  const byEmail = new Map<string, CustomerLite[]>();
  const byPhone = new Map<string, CustomerLite[]>();

  for (const p of rows) {
    const e = normalizeWhooshEmail(p.email);
    if (e) {
      const list = byEmail.get(e) ?? [];
      list.push(p);
      byEmail.set(e, list);
    }
    const ph = normalizeWhooshPhone(p.phone);
    if (ph) {
      const list = byPhone.get(ph) ?? [];
      list.push(p);
      byPhone.set(ph, list);
    }
  }

  return { byEmail, byPhone };
}

export function resolveCustomerMatch(input: {
  email: string | null;
  phone: string | null;
  byEmail: Map<string, CustomerLite[]>;
  byPhone: Map<string, CustomerLite[]>;
}): {
  customerId: string | null;
  method: string | null;
  confidence: number | null;
  ambiguous: boolean;
} {
  const { email, phone, byEmail, byPhone } = input;

  const emailList = email ? (byEmail.get(email) ?? []) : [];
  const phoneList = phone ? (byPhone.get(phone) ?? []) : [];

  if (emailList.length > 1 || phoneList.length > 1) {
    return {
      customerId: null,
      method: "ambiguous",
      confidence: null,
      ambiguous: true,
    };
  }

  if (emailList.length === 1 && phoneList.length === 0) {
    return {
      customerId: emailList[0]!.id,
      method: "email",
      confidence: 75,
      ambiguous: false,
    };
  }

  if (emailList.length === 0 && phoneList.length === 1) {
    return {
      customerId: phoneList[0]!.id,
      method: "phone",
      confidence: 70,
      ambiguous: false,
    };
  }

  if (emailList.length === 1 && phoneList.length === 1) {
    if (emailList[0]!.id === phoneList[0]!.id) {
      return {
        customerId: emailList[0]!.id,
        method: "email_phone",
        confidence: 85,
        ambiguous: false,
      };
    }
    return {
      customerId: null,
      method: "ambiguous",
      confidence: null,
      ambiguous: true,
    };
  }

  if (!email && !phone) {
    return {
      customerId: null,
      method: "name_only_pending",
      confidence: null,
      ambiguous: false,
    };
  }

  return {
    customerId: null,
    method: null,
    confidence: null,
    ambiguous: false,
  };
}

function mergeIdentitySourcesTag(
  existing: string[] | null | undefined,
  tag: string
): string[] {
  const base = Array.isArray(existing) ? [...existing] : [];
  if (!base.includes(tag)) base.push(tag);
  return base;
}

export async function safeMergeWhooshIntoCustomer(input: {
  supabase: SupabaseClient;
  businessId: string;
  customerId: string;
  whoosh: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    isMember: boolean;
  };
}) {
  const { supabase, businessId, customerId, whoosh } = input;

  const { data: existing, error } = await supabase
    .from("customer_profiles")
    .select(
      "first_name, last_name, email, phone, is_member, identity_sources"
    )
    .eq("id", customerId)
    .eq("business_id", businessId)
    .maybeSingle();

  if (error || !existing) return;

  const row = existing as {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    is_member: boolean | null;
    identity_sources: string[] | null;
  };

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = {
    updated_at: now,
  };

  if (!row.first_name?.trim() && whoosh.firstName.trim()) {
    updates.first_name = whoosh.firstName.trim();
  }
  if (!row.last_name?.trim() && whoosh.lastName.trim()) {
    updates.last_name = whoosh.lastName.trim();
  }
  if (!row.email?.trim() && whoosh.email) {
    updates.email = whoosh.email;
  }
  if (!row.phone?.trim() && whoosh.phone) {
    updates.phone = whoosh.phone;
  }

  if (whoosh.isMember) {
    updates.is_member = true;
  }

  const mergedSources = mergeIdentitySourcesTag(row.identity_sources, "whoosh");
  const sourcesChanged = !(row.identity_sources ?? []).includes("whoosh");

  if (sourcesChanged) {
    updates.identity_sources = mergedSources;
    updates.last_identity_enriched_at = now;
  }

  const hasAnyChange = Object.keys(updates).some((k) => k !== "updated_at");
  if (!hasAnyChange) {
    return;
  }

  const { error: upErr } = await supabase
    .from("customer_profiles")
    .update(updates)
    .eq("id", customerId)
    .eq("business_id", businessId);

  if (upErr) throw new Error(upErr.message);
}

/**
 * After Whoosh import: for every matched whoosh row, fill blank customer_profile
 * fields from Whoosh (aggregate multiple Whoosh rows per customer).
 * Does not overwrite non-empty email/phone/name.
 */
export async function backfillCustomerProfilesFromMatchedWhoosh(input: {
  supabase: SupabaseClient;
  businessId: string;
}) {
  const { supabase, businessId } = input;

  const { data: whooshRows, error: wErr } = await supabase
    .from("whoosh_profiles")
    .select(
      "matched_customer_profile_id, first_name, last_name, email, phone, is_member"
    )
    .eq("business_id", businessId)
    .eq("source", "whoosh_roster")
    .not("matched_customer_profile_id", "is", null);

  if (wErr) throw new Error(wErr.message);

  type Wp = {
    matched_customer_profile_id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    is_member: boolean;
  };

  const grouped = new Map<string, Wp[]>();
  for (const w of (whooshRows ?? []) as Wp[]) {
    const cid = w.matched_customer_profile_id;
    const list = grouped.get(cid) ?? [];
    list.push(w);
    grouped.set(cid, list);
  }

  for (const [customerId, wps] of grouped) {
    let pickFirst = "";
    let pickLast = "";
    let pickEmail: string | null = null;
    let pickPhone: string | null = null;
    let anyMember = false;

    for (const wp of wps) {
      if (!pickFirst && wp.first_name?.trim()) pickFirst = wp.first_name.trim();
      if (!pickLast && wp.last_name?.trim()) pickLast = wp.last_name.trim();
      if (!pickEmail && normalizeWhooshEmail(wp.email)) {
        pickEmail = normalizeWhooshEmail(wp.email);
      }
      if (!pickPhone && normalizeWhooshPhone(wp.phone)) {
        pickPhone = normalizeWhooshPhone(wp.phone);
      }
      if (wp.is_member) anyMember = true;
    }

    await safeMergeWhooshIntoCustomer({
      supabase,
      businessId,
      customerId,
      whoosh: {
        firstName: pickFirst,
        lastName: pickLast,
        email: pickEmail,
        phone: pickPhone,
        isMember: anyMember,
      },
    });
  }

  return { customersBackfilled: grouped.size };
}

export async function createWhooshCustomerProfile(input: {
  supabase: SupabaseClient;
  businessId: string;
  externalId: string;
  whoosh: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    isMember: boolean;
  };
  confidence: number;
}) {
  const { supabase, businessId, externalId, whoosh, confidence } = input;

  if (!whoosh.email && !whoosh.phone) {
    throw new Error("Cannot create customer without email or phone");
  }

  const payload = {
    business_id: businessId,
    source: "whoosh",
    external_customer_id: `whoosh:${externalId}`,
    first_name: whoosh.firstName.trim() || null,
    last_name: whoosh.lastName.trim() || null,
    email: whoosh.email,
    phone: whoosh.phone,
    is_member: whoosh.isMember,
    identity_confidence: confidence,
    identity_sources: ["whoosh"],
    last_identity_enriched_at: new Date().toISOString(),
    ai_segment: "whoosh_roster",
    ai_score: 0,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("customer_profiles")
    .upsert(payload, { onConflict: "source,external_customer_id" })
    .select("id")
    .single();

  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

/**
 * Whoosh-matched customer for a calendar booking: exact email beats exact phone if they disagree.
 */
export function resolveWhooshMatchedCustomerIdForBooking(input: {
  normalizedEmail: string | null;
  normalizedPhone: string | null;
  emailToProfile: Map<string, string>;
  phoneToProfile: Map<string, string>;
}): string | null {
  const { normalizedEmail: be, normalizedPhone: bp, emailToProfile, phoneToProfile } =
    input;

  const byEmail = be ? (emailToProfile.get(be) ?? null) : null;
  const byPhone = bp ? (phoneToProfile.get(bp) ?? null) : null;

  if (byEmail && byPhone && byEmail !== byPhone) {
    return byEmail;
  }
  if (byEmail) return byEmail;
  if (byPhone) return byPhone;
  return null;
}

type WhooshProfileRow = {
  id: string;
  external_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  is_member: boolean;
  matched_customer_profile_id: string | null;
  customer_type: string | null;
  match_method: string | null;
};

const canAutoLinkFromWhoosh = (m: string | null) =>
  m === null || m === "no_identity" || m === "name_only_pending";

/**
 * Attach or repair `booking_reservations.customer_profile_id` using matched Whoosh
 * identities (exact email / exact phone). Does not use name. Email wins on conflict.
 */
export async function syncBookingReservationsFromWhoosh(input: {
  supabase: SupabaseClient;
  businessId: string;
}) {
  const { supabase, businessId } = input;

  const { data: whooshList, error: wErr } = await supabase
    .from("whoosh_profiles")
    .select(
      "id, external_id, email, phone, first_name, last_name, is_member, matched_customer_profile_id, customer_type, match_method"
    )
    .eq("business_id", businessId)
    .eq("source", "whoosh_roster");

  if (wErr) throw new Error(wErr.message);

  const whooshRows = (whooshList ?? []) as WhooshProfileRow[];

  const emailToProfile = new Map<string, string>();
  const phoneToProfile = new Map<string, string>();
  const unmatchedByEmail = new Map<string, WhooshProfileRow>();
  const unmatchedByPhone = new Map<string, WhooshProfileRow>();

  for (const w of whooshRows) {
    const e = normalizeWhooshEmail(w.email);
    const ph = normalizeWhooshPhone(w.phone);
    if (w.matched_customer_profile_id) {
      if (e) emailToProfile.set(e, w.matched_customer_profile_id);
      if (ph) phoneToProfile.set(ph, w.matched_customer_profile_id);
    } else if (canAutoLinkFromWhoosh(w.match_method)) {
      if (e) unmatchedByEmail.set(e, w);
      if (ph) unmatchedByPhone.set(ph, w);
    }
  }

  let attachedNew = 0;
  let repaired = 0;
  let createdFromBooking = 0;
  const now = new Date().toISOString();
  const createdWhooshExternals = new Set<string>();

  for (let iteration = 0; iteration < 10; iteration++) {
    const { data: bookings, error: bErr } = await supabase
      .from("booking_reservations")
      .select("id, customer_email, customer_phone, customer_profile_id")
      .eq("business_id", businessId)
      .eq("source", "google_calendar");

    if (bErr) throw new Error(bErr.message);

    let roundMutations = 0;

    for (const b of bookings ?? []) {
      const be = normalizeWhooshEmail(b.customer_email as string | null);
      const bp = normalizeWhooshPhone(b.customer_phone as string | null);
      const current = (b.customer_profile_id as string | null) ?? null;

      let targetId = resolveWhooshMatchedCustomerIdForBooking({
        normalizedEmail: be,
        normalizedPhone: bp,
        emailToProfile,
        phoneToProfile,
      });

      if (!targetId && !current) {
        if (be) {
          const w = unmatchedByEmail.get(be);
          if (
            w &&
            (w.email || w.phone) &&
            !createdWhooshExternals.has(w.external_id)
          ) {
            const { isMember } = parseWhooshCustomerType(w.customer_type ?? "");
            try {
              targetId = await createWhooshCustomerProfile({
                supabase,
                businessId,
                externalId: w.external_id,
                whoosh: {
                  firstName: w.first_name ?? "",
                  lastName: w.last_name ?? "",
                  email: normalizeWhooshEmail(w.email),
                  phone: normalizeWhooshPhone(w.phone),
                  isMember,
                },
                confidence: w.email && w.phone ? 85 : w.email ? 75 : 70,
              });
              createdWhooshExternals.add(w.external_id);
              createdFromBooking += 1;
              roundMutations += 1;
              const conf = w.email && w.phone ? 85 : w.email ? 75 : 70;
              const em = normalizeWhooshEmail(w.email);

              if (em) {
                await supabase
                  .from("whoosh_profiles")
                  .update({
                    matched_customer_profile_id: targetId,
                    match_method: "booking_orphan_created",
                    match_confidence: conf,
                    updated_at: now,
                  })
                  .eq("business_id", businessId)
                  .eq("source", "whoosh_roster")
                  .eq("email", em)
                  .is("matched_customer_profile_id", null);

                emailToProfile.set(em, targetId);
              } else {
                await supabase
                  .from("whoosh_profiles")
                  .update({
                    matched_customer_profile_id: targetId,
                    match_method: "booking_orphan_created",
                    match_confidence: conf,
                    updated_at: now,
                  })
                  .eq("id", w.id);
              }

              const phn = normalizeWhooshPhone(w.phone);
              if (phn) phoneToProfile.set(phn, targetId);
            } catch {
              targetId = null;
            }
          }
        }

        if (!targetId && bp) {
          const w = unmatchedByPhone.get(bp);
          if (
            w &&
            (w.email || w.phone) &&
            !createdWhooshExternals.has(w.external_id)
          ) {
            const { isMember } = parseWhooshCustomerType(w.customer_type ?? "");
            try {
              targetId = await createWhooshCustomerProfile({
                supabase,
                businessId,
                externalId: w.external_id,
                whoosh: {
                  firstName: w.first_name ?? "",
                  lastName: w.last_name ?? "",
                  email: normalizeWhooshEmail(w.email),
                  phone: normalizeWhooshPhone(w.phone),
                  isMember,
                },
                confidence: w.email && w.phone ? 85 : w.email ? 75 : 70,
              });
              createdWhooshExternals.add(w.external_id);
              createdFromBooking += 1;
              roundMutations += 1;
              const conf = w.email && w.phone ? 85 : w.email ? 75 : 70;

              await supabase
                .from("whoosh_profiles")
                .update({
                  matched_customer_profile_id: targetId,
                  match_method: "booking_orphan_created",
                  match_confidence: conf,
                  updated_at: now,
                })
                .eq("business_id", businessId)
                .eq("source", "whoosh_roster")
                .eq("phone", w.phone)
                .is("matched_customer_profile_id", null);

              if (normalizeWhooshEmail(w.email)) {
                emailToProfile.set(normalizeWhooshEmail(w.email)!, targetId);
              }
              phoneToProfile.set(bp, targetId);
            } catch {
              targetId = null;
            }
          }
        }
      }

      if (!targetId || current === targetId) continue;

      const { error: uErr } = await supabase
        .from("booking_reservations")
        .update({
          customer_profile_id: targetId,
          updated_at: now,
        })
        .eq("id", b.id)
        .eq("business_id", businessId);

      if (uErr) continue;

      roundMutations += 1;
      if (current) repaired += 1;
      else attachedNew += 1;
    }

    if (roundMutations === 0) break;
  }

  return {
    attachedNew,
    repaired,
    createdFromBooking,
    totalUpdated: attachedNew + repaired,
  };
}
