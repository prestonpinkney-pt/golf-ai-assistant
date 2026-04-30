import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { encryptToken } from "@/lib/square-token-crypto";
import { BUSINESS_ID } from "../../../config";

const PRIMETIME_GOLF_BUSINESS_ID = BUSINESS_ID;

type SquareTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  merchant_id: string;
};

type SquareLocation = {
  id: string;
  status?: string;
};

function getSquareOauthTokenUrl() {
  if (process.env.SQUARE_ENVIRONMENT === "sandbox") {
    return "https://connect.squareupsandbox.com/oauth2/token";
  }

  return "https://connect.squareup.com/oauth2/token";
}

function getSquareApiBaseUrl() {
  if (process.env.SQUARE_ENVIRONMENT === "sandbox") {
    return "https://connect.squareupsandbox.com";
  }

  return "https://connect.squareup.com";
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

async function getPrimarySquareLocation(accessToken: string) {
  const response = await fetch(`${getSquareApiBaseUrl()}/v2/locations`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": "2025-01-23",
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();

  const activeLocation = data.locations?.find(
    (location: SquareLocation) => location.status === "ACTIVE"
  );

  return activeLocation?.id ?? data.locations?.[0]?.id ?? null;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(
  new URL(`/opportunities?square=error`, request.url)
);
  }

  if (!code || !state) {
    return NextResponse.json(
      { error: "Missing Square OAuth code or state" },
      { status: 400 }
    );
  }

  const savedState = request.cookies.get("square_oauth_state")?.value;

  if (!savedState || savedState !== state) {
    return NextResponse.json(
      { error: "Invalid Square OAuth state" },
      { status: 400 }
    );
  }

  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const applicationSecret = process.env.SQUARE_APPLICATION_SECRET;
  const redirectUrl = process.env.SQUARE_REDIRECT_URL;

  if (!applicationId || !applicationSecret || !redirectUrl) {
    return NextResponse.json(
      { error: "Missing Square OAuth environment variables" },
      { status: 500 }
    );
  }

  const tokenResponse = await fetch(getSquareOauthTokenUrl(), {
    method: "POST",
    headers: {
      "Square-Version": "2025-01-23",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: applicationId,
      client_secret: applicationSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUrl,
    }),
  });

  if (!tokenResponse.ok) {
    const details = await tokenResponse.text();

    return NextResponse.json(
      {
        error: "Failed to exchange Square authorization code",
        details,
      },
      { status: 400 }
    );
  }

  const tokenData = (await tokenResponse.json()) as SquareTokenResponse;

  const locationId = await getPrimarySquareLocation(tokenData.access_token);

  const supabase = getSupabaseAdmin();

  const { error: upsertError } = await supabase
    .from("square_connections")
    .upsert(
      {
        business_id: PRIMETIME_GOLF_BUSINESS_ID,
        merchant_id: tokenData.merchant_id,
        location_id: locationId,
        access_token_encrypted: encryptToken(tokenData.access_token),
        refresh_token_encrypted: tokenData.refresh_token
          ? encryptToken(tokenData.refresh_token)
          : null,
        expires_at: tokenData.expires_at ?? null,
        revoked_at: null,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "business_id",
      }
    );

  if (upsertError) {
    return NextResponse.json(
      {
        error: "Failed to save Square connection",
        details: upsertError.message,
      },
      { status: 500 }
    );
  }

  const response = NextResponse.redirect(
  new URL("/opportunities?square=connected", request.url)
);

  response.cookies.delete("square_oauth_state");

  return response;
}