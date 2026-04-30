import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { decryptToken } from "@/lib/square-token-crypto";
import { gateBusinessUser } from "../../../lib/require-auth";
import { BUSINESS_ID } from "../../../config";

const PRIMETIME_GOLF_BUSINESS_ID = BUSINESS_ID;
const SQUARE_VERSION = "2025-01-23";

type SquareConnection = {
  access_token_encrypted: string;
  revoked_at: string | null;
};

type CustomerProfile = {
  id: string;
  external_customer_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  is_member: boolean;
  exclude_from_ai_targeting: boolean;
};

type SquareCustomer = {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
  company_name?: string;
  created_at?: string;
  updated_at?: string;
};

function getSquareApiBaseUrl() {
  return process.env.SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retrieveSquareCustomer(
  accessToken: string,
  squareCustomerId: string
) {
  const response = await fetch(
    `${getSquareApiBaseUrl()}/v2/customers/${squareCustomerId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": SQUARE_VERSION,
        "Content-Type": "application/json",
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    const isRateLimited = response.status === 429 || text.includes("RATE_LIMITED");

    if (isRateLimited) {
      throw new Error("RATE_LIMITED");
    }

    throw new Error(
      `Failed to retrieve Square customer ${squareCustomerId}: ${text}`
    );
  }

  const data = text
    ? (JSON.parse(text) as { customer?: SquareCustomer })
    : { customer: undefined };

  return data.customer ?? null;
}

export async function POST() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();

    const { data: connectionData, error: connectionError } = await supabase
      .from("square_connections")
      .select("access_token_encrypted, revoked_at")
      .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
      .single();

    const connection = connectionData as SquareConnection | null;

    if (connectionError || !connection) {
      return NextResponse.json(
        {
          error: "Square is not connected",
          details: connectionError?.message,
        },
        { status: 400 }
      );
    }

    if (connection.revoked_at) {
      return NextResponse.json(
        { error: "Square connection has been revoked" },
        { status: 400 }
      );
    }

    const { data: profilesData, error: profilesError } = await supabase
      .from("customer_profiles")
      .select(
        `
        id,
        external_customer_id,
        first_name,
        last_name,
        email,
        phone,
        is_member,
        exclude_from_ai_targeting
      `
      )
      .eq("business_id", PRIMETIME_GOLF_BUSINESS_ID)
      .eq("source", "square")
      .eq("is_member", false)
      .eq("exclude_from_ai_targeting", false)
      .limit(25);

    if (profilesError) {
      return NextResponse.json(
        {
          error: "Failed to load customer profiles",
          details: profilesError.message,
        },
        { status: 500 }
      );
    }

    const profiles = ((profilesData ?? []) as CustomerProfile[]).filter(
      (profile) =>
        !profile.first_name &&
        !profile.last_name &&
        !profile.email &&
        !profile.phone
    );

    if (profiles.length === 0) {
      return NextResponse.json({
        enriched: 0,
        skipped: 0,
        message: "No customer profiles need enrichment",
      });
    }

    const accessToken = decryptToken(connection.access_token_encrypted);

    let enriched = 0;
    let skipped = 0;
    let rateLimited = false;

    for (const profile of profiles) {
      try {
        const customer = await retrieveSquareCustomer(
          accessToken,
          profile.external_customer_id
        );

        if (!customer) {
          skipped += 1;
          continue;
        }

        const { error: updateError } = await supabase
          .from("customer_profiles")
          .update({
            first_name: customer.given_name ?? null,
            last_name: customer.family_name ?? null,
            email: customer.email_address ?? null,
            phone: customer.phone_number ?? null,
            company_name: customer.company_name ?? null,
            raw_payload: customer,
            updated_at: new Date().toISOString(),
          })
          .eq("id", profile.id);

        if (updateError) {
          throw new Error(updateError.message);
        }

        enriched += 1;

        await sleep(350);
      } catch (error) {
        if (error instanceof Error && error.message === "RATE_LIMITED") {
          rateLimited = true;
          break;
        }

        skipped += 1;
      }
    }

    return NextResponse.json({
      enriched,
      skipped,
      rateLimited,
      remainingHint:
        rateLimited || profiles.length === 25
          ? "Run this endpoint again later to continue enriching more customers."
          : null,
    });
  } catch (error) {
    console.error("Square customer enrichment failed:", error);

    return NextResponse.json(
      {
        error: "Square customer enrichment failed",
        details: error instanceof Error ? error.message : "Unknown server error",
      },
      { status: 500 }
    );
  }
}