import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../../lib/require-auth";
import { BUSINESS_ID } from "../../../config";
import { evaluateGoogleCalendarBookingOpportunities } from "../../../lib/google-calendar-booking-opportunities";
import { findCustomerProfileIdByContact } from "../../../lib/google-calendar-customer-match";
import {
  coercePublicCustomerEmail,
  loadWhooshNameIndex,
  parseLessonParenTitle,
  resolveLessonBookingIdentity,
} from "../../../lib/lesson-whoosh-identity";
import {
  backfillCustomerProfilesFromMatchedWhoosh,
  normalizeWhooshPhone,
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

/**
 * Re-derives lesson customer identity from `Lesson (Name)` titles + Whoosh roster,
 * strips internal calendar emails from non-paren lessons, then backfills profiles
 * and refreshes booking opportunities.
 */
export async function POST() {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  try {
    const supabase = getSupabaseAdmin();
    const nameIndex = await loadWhooshNameIndex(supabase, BUSINESS_ID);

    const { data: rows, error } = await supabase
      .from("booking_reservations")
      .select(
        "id, title, customer_name, customer_email, customer_phone, customer_profile_id"
      )
      .eq("business_id", BUSINESS_ID)
      .eq("source", "google_calendar")
      .eq("reservation_type", "lesson");

    if (error) {
      return NextResponse.json(
        { error: "Failed to load lesson bookings", details: error.message },
        { status: 500 }
      );
    }

    let updatedRows = 0;
    const now = new Date().toISOString();

    for (const row of rows ?? []) {
      const title = (row.title as string) ?? "";
      const parse = parseLessonParenTitle(title);

      let customerName = row.customer_name as string | null;
      let customerEmail: string | null =
        (row.customer_email as string | null) ?? null;
      let customerPhone: string | null =
        (row.customer_phone as string | null) ?? null;
      let customerProfileId =
        (row.customer_profile_id as string | null) ?? null;

      if (parse.kind === "none") {
        customerEmail = coercePublicCustomerEmail(customerEmail);
        customerPhone = normalizeWhooshPhone(customerPhone);
        customerProfileId = await findCustomerProfileIdByContact({
          supabase,
          businessId: BUSINESS_ID,
          email: customerEmail,
          phone: customerPhone,
        });
      } else if (parse.kind === "unknown") {
        customerName = "Unknown Customer";
        customerEmail = null;
        customerPhone = null;
        customerProfileId = null;
      } else {
        const resolved = await resolveLessonBookingIdentity({
          supabase,
          businessId: BUSINESS_ID,
          title,
          nameIndex,
        });
        customerName = resolved.customerName;
        customerEmail = resolved.customerEmail;
        customerPhone = resolved.customerPhone;
        customerProfileId = resolved.customerProfileId;
      }

      const prevEmail = (row.customer_email as string | null) ?? null;
      const prevPhone = (row.customer_phone as string | null) ?? null;
      const prevProfile = (row.customer_profile_id as string | null) ?? null;
      const prevName = (row.customer_name as string | null) ?? null;

      const changed =
        customerName !== prevName ||
        customerEmail !== prevEmail ||
        customerPhone !== prevPhone ||
        customerProfileId !== prevProfile;

      if (!changed) continue;

      const { error: uErr } = await supabase
        .from("booking_reservations")
        .update({
          customer_name: customerName,
          customer_email: customerEmail,
          customer_phone: customerPhone,
          customer_profile_id: customerProfileId,
          updated_at: now,
        })
        .eq("id", row.id as string)
        .eq("business_id", BUSINESS_ID);

      if (!uErr) updatedRows += 1;
    }

    const backfill = await backfillCustomerProfilesFromMatchedWhoosh({
      supabase,
      businessId: BUSINESS_ID,
    });

    let bookingOpportunities:
      | Awaited<ReturnType<typeof evaluateGoogleCalendarBookingOpportunities>>
      | { error: string } = { error: "skipped" };

    try {
      bookingOpportunities = await evaluateGoogleCalendarBookingOpportunities({
        supabase,
        businessId: BUSINESS_ID,
      });
    } catch (e) {
      bookingOpportunities = {
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }

    return NextResponse.json({
      success: true,
      bookingReservationsUpdated: updatedRows,
      backfill,
      bookingOpportunities,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Lesson identity repair failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
