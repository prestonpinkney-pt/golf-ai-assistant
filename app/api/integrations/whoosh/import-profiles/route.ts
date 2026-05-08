import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BUSINESS_ID } from "../../../config";
import { gateBusinessUser } from "../../../lib/require-auth";
import { readFile } from "fs/promises";
import path from "path";
import { evaluateGoogleCalendarBookingOpportunities } from "../../../lib/google-calendar-booking-opportunities";
import {
  backfillCustomerProfilesFromMatchedWhoosh,
  buildCustomerIndexes,
  createWhooshCustomerProfile,
  matrixToWhooshRows,
  normalizeWhooshEmail,
  normalizeWhooshPhone,
  parseCsvToMatrix,
  parseWhooshCustomerType,
  resolveCustomerMatch,
  safeMergeWhooshIntoCustomer,
  syncBookingReservationsFromWhoosh,
  type WhooshCsvRow,
} from "../../../lib/whoosh-import";

export const maxDuration = 300;

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

type CustomerLite = {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  is_member: boolean | null;
};

function addCustomerToIndexes(
  byEmail: Map<string, CustomerLite[]>,
  byPhone: Map<string, CustomerLite[]>,
  profile: CustomerLite
) {
  const e = normalizeWhooshEmail(profile.email);
  if (e) {
    const list = byEmail.get(e) ?? [];
    if (!list.some((p) => p.id === profile.id)) {
      list.push(profile);
      byEmail.set(e, list);
    }
  }
  const ph = normalizeWhooshPhone(profile.phone);
  if (ph) {
    const list = byPhone.get(ph) ?? [];
    if (!list.some((p) => p.id === profile.id)) {
      list.push(profile);
      byPhone.set(ph, list);
    }
  }
}

async function loadAllCustomerProfiles(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  businessId: string
) {
  const pageSize = 1000;
  let from = 0;
  const all: CustomerLite[] = [];

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("id, email, phone, first_name, last_name, is_member")
      .eq("business_id", businessId)
      .range(from, to);

    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as CustomerLite[];
    all.push(...chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }

  return all;
}

function whooshRowToUpsertPayload(
  businessId: string,
  row: WhooshCsvRow,
  meta: { raw: Record<string, unknown> }
) {
  const ext = `csv-row-${row.lineIndex}`;
  const { customerType, isMember, membershipName } = parseWhooshCustomerType(
    row.customerType
  );
  const fullName = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();

  return {
    business_id: businessId,
    source: "whoosh_roster",
    external_id: ext,
    first_name: row.firstName.trim() || null,
    last_name: row.lastName.trim() || null,
    full_name: fullName || null,
    email: row.email,
    phone: row.phone,
    customer_type: customerType,
    is_member: isMember,
    membership_name: membershipName,
    date_of_birth: row.dateOfBirth.trim() || null,
    raw_payload: meta.raw,
    updated_at: new Date().toISOString(),
  };
}

async function upsertWhooshProfilesBatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  rows: ReturnType<typeof whooshRowToUpsertPayload>[]
) {
  const { error } = await supabase.from("whoosh_profiles").upsert(rows, {
    onConflict: "business_id,source,external_id",
  });
  if (error) throw new Error(error.message);
}

async function updateWhooshMatch(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  businessId: string,
  externalId: string,
  fields: {
    matched_customer_profile_id: string | null;
    match_method: string | null;
    match_confidence: number | null;
  }
) {
  const { error } = await supabase
    .from("whoosh_profiles")
    .update({
      ...fields,
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId)
    .eq("source", "whoosh_roster")
    .eq("external_id", externalId);

  if (error) throw new Error(error.message);
}

export async function POST(request: NextRequest) {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();
    const businessId = BUSINESS_ID;

    let text: string | null = null;
    let rowsInput: WhooshCsvRow[] | null = null;

    const contentType = request.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (file instanceof File) {
        text = await file.text();
      }
    } else if (contentType.includes("application/json")) {
      const body = (await request.json()) as {
        rows?: WhooshCsvRow[];
        csvText?: string;
      };
      if (body.rows?.length) {
        rowsInput = body.rows;
      } else if (body.csvText) {
        text = body.csvText;
      }
    }

    const envPath = process.env.WHOOSH_IMPORT_CSV_PATH?.trim();
    if (!text && !rowsInput && envPath) {
      const resolved = path.resolve(envPath);
      text = await readFile(resolved, "utf-8");
    }

    let whooshRows: WhooshCsvRow[];
    if (rowsInput) {
      whooshRows = rowsInput;
    } else if (text) {
      const matrix = parseCsvToMatrix(text);
      whooshRows = matrixToWhooshRows(matrix);
    } else {
      return NextResponse.json(
        {
          error:
            "Provide CSV as multipart field `file`, JSON { csvText } or { rows }, or set WHOOSH_IMPORT_CSV_PATH",
        },
        { status: 400 }
      );
    }

    const BATCH = 150;
    for (let i = 0; i < whooshRows.length; i += BATCH) {
      const slice = whooshRows.slice(i, i + BATCH);
      const payloads = slice.map((row) =>
        whooshRowToUpsertPayload(businessId, row, {
          raw: {
            lineIndex: row.lineIndex,
            customerType: row.customerType,
            dateOfBirth: row.dateOfBirth,
          },
        })
      );
      await upsertWhooshProfilesBatch(supabase, payloads);
    }

    let customers = await loadAllCustomerProfiles(supabase, businessId);
    let { byEmail, byPhone } = buildCustomerIndexes(customers);

    let matched = 0;
    let ambiguous = 0;
    let created = 0;
    let nameOnly = 0;
    let createFailed = 0;

    for (const row of whooshRows) {
      const ext = `csv-row-${row.lineIndex}`;
      const { isMember } = parseWhooshCustomerType(row.customerType);

      const resolution = resolveCustomerMatch({
        email: row.email,
        phone: row.phone,
        byEmail,
        byPhone,
      });

      if (resolution.method === "name_only_pending") {
        nameOnly += 1;
        await updateWhooshMatch(supabase, businessId, ext, {
          matched_customer_profile_id: null,
          match_method: "name_only_pending",
          match_confidence: null,
        });
        continue;
      }

      if (resolution.ambiguous) {
        ambiguous += 1;
        await updateWhooshMatch(supabase, businessId, ext, {
          matched_customer_profile_id: null,
          match_method: "ambiguous",
          match_confidence: null,
        });
        continue;
      }

      if (resolution.customerId) {
        matched += 1;
        await safeMergeWhooshIntoCustomer({
          supabase,
          businessId,
          customerId: resolution.customerId,
          whoosh: {
            firstName: row.firstName,
            lastName: row.lastName,
            email: row.email,
            phone: row.phone,
            isMember,
          },
        });
        await updateWhooshMatch(supabase, businessId, ext, {
          matched_customer_profile_id: resolution.customerId,
          match_method: resolution.method,
          match_confidence: resolution.confidence,
        });
        continue;
      }

      if (row.email || row.phone) {
        const conf = row.email && row.phone ? 85 : row.email ? 75 : 70;
        let newId: string;
        try {
          newId = await createWhooshCustomerProfile({
            supabase,
            businessId,
            externalId: ext,
            whoosh: {
              firstName: row.firstName,
              lastName: row.lastName,
              email: row.email,
              phone: row.phone,
              isMember,
            },
            confidence: conf,
          });
        } catch (err) {
          createFailed += 1;
          console.error(
            `[whoosh/import-profiles] Failed to create profile for row ${row.lineIndex}:`,
            err instanceof Error ? err.message : err
          );
          await updateWhooshMatch(supabase, businessId, ext, {
            matched_customer_profile_id: null,
            match_method: "create_failed",
            match_confidence: null,
          });
          continue;
        }
        created += 1;
        const newProfile: CustomerLite = {
          id: newId,
          email: row.email,
          phone: row.phone,
          first_name: row.firstName.trim() || null,
          last_name: row.lastName.trim() || null,
          is_member: isMember,
        };
        customers = [...customers, newProfile];
        addCustomerToIndexes(byEmail, byPhone, newProfile);
        await updateWhooshMatch(supabase, businessId, ext, {
          matched_customer_profile_id: newId,
          match_method: "created_whoosh",
          match_confidence: conf,
        });
      } else {
        await updateWhooshMatch(supabase, businessId, ext, {
          matched_customer_profile_id: null,
          match_method: "no_identity",
          match_confidence: null,
        });
      }
    }

    const bookingStats = await syncBookingReservationsFromWhoosh({
      supabase,
      businessId,
    });

    let whooshBackfill: { customersBackfilled: number } | { error: string } = {
      customersBackfilled: 0,
    };
    try {
      whooshBackfill = await backfillCustomerProfilesFromMatchedWhoosh({
        supabase,
        businessId,
      });
    } catch (e) {
      whooshBackfill = {
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }

    let bookingOpportunities: unknown = null;
    try {
      bookingOpportunities = await evaluateGoogleCalendarBookingOpportunities({
        supabase,
        businessId,
      });
    } catch (e) {
      bookingOpportunities = {
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }

    return NextResponse.json({
      success: true,
      businessId,
      whooshRowsProcessed: whooshRows.length,
      customerMatchStats: {
        matchedExisting: matched,
        ambiguous,
        createdNew: created,
        nameOnlyPending: nameOnly,
        createFailed,
      },
      bookingReservationAttach: bookingStats,
      whooshCustomerBackfill: whooshBackfill,
      bookingOpportunities,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Whoosh import failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
