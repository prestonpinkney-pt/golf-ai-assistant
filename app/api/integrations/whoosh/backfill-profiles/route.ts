import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { BUSINESS_ID } from "../../../config";
import { gateBusinessUser } from "../../../lib/require-auth";
import {
  backfillCustomerProfilesFromMatchedWhoosh,
  syncBookingReservationsFromWhoosh,
} from "../../../lib/whoosh-import";
import { evaluateGoogleCalendarBookingOpportunities } from "../../../lib/google-calendar-booking-opportunities";

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
 * One-off or repeat: re-sync calendar bookings to Whoosh-matched customers,
 * backfill customer_profiles from Whoosh, then refresh booking opportunities.
 */
export async function POST() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();

    const bookingSync = await syncBookingReservationsFromWhoosh({
      supabase,
      businessId: BUSINESS_ID,
    });

    const whooshBackfill = await backfillCustomerProfilesFromMatchedWhoosh({
      supabase,
      businessId: BUSINESS_ID,
    });

    let bookingOpportunities: unknown = null;
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
      bookingReservationSync: bookingSync,
      whooshCustomerBackfill: whooshBackfill,
      bookingOpportunities,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Whoosh backfill failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
