import crypto from "crypto";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../../lib/require-auth";

const SCOPES = [
  "PAYMENTS_READ",
  "ORDERS_READ",
  "MERCHANT_PROFILE_READ",
  "CUSTOMERS_READ",
];

function getSquareAuthorizeUrl() {
  const environment = process.env.SQUARE_ENVIRONMENT;

  if (environment === "sandbox") {
    return "https://connect.squareupsandbox.com/oauth2/authorize";
  }

  return "https://connect.squareup.com/oauth2/authorize";
}

export async function GET() {
  const denied = await gateBusinessUser();
  if (denied) return denied;

  const applicationId = process.env.SQUARE_APPLICATION_ID;
  const redirectUrl = process.env.SQUARE_REDIRECT_URL;

  if (!applicationId || !redirectUrl) {
    return NextResponse.json(
      { error: "Missing Square OAuth environment variables" },
      { status: 500 }
    );
  }

  const state = crypto.randomBytes(24).toString("hex");

  const params = new URLSearchParams({
    client_id: applicationId,
    scope: SCOPES.join(" "),
    session: "false",
    state,
    redirect_uri: redirectUrl,
  });

  const response = NextResponse.redirect(
    `${getSquareAuthorizeUrl()}?${params.toString()}`
  );

  response.cookies.set("square_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 10,
  });

  return response;
}