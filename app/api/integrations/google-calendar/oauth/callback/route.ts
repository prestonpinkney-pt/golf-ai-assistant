import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { BUSINESS_ID } from "../../../../config";

type GoogleUserInfo = {
  email?: string;
};

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

function getOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Google OAuth environment variables");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function successHtml(email: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Calendar Connected</title>
    <style>
      body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; }
      .card { max-width: 680px; margin: 48px auto; padding: 24px; border-radius: 12px; background: #111827; border: 1px solid #334155; }
      h1 { margin: 0 0 12px; color: #22c55e; font-size: 24px; }
      p { line-height: 1.5; margin: 8px 0; }
      code { background: #1e293b; border-radius: 6px; padding: 2px 6px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Google Calendar Connected</h1>
      <p>CloseOS successfully connected Google Calendar for business <code>${BUSINESS_ID}</code>.</p>
      <p>Connected account: <code>${email}</code>.</p>
      <p>You can close this window and run calendar sync from CloseOS.</p>
    </div>
  </body>
</html>`;
}

function failureHtml(message: string) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Google Calendar Connection Failed</title>
    <style>
      body { font-family: Arial, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; }
      .card { max-width: 680px; margin: 48px auto; padding: 24px; border-radius: 12px; background: #111827; border: 1px solid #334155; }
      h1 { margin: 0 0 12px; color: #ef4444; font-size: 24px; }
      p { line-height: 1.5; margin: 8px 0; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Google Calendar Connection Failed</h1>
      <p>${message}</p>
      <p>Please retry from <code>/api/integrations/google-calendar/oauth/start</code>.</p>
    </div>
  </body>
</html>`;
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return new NextResponse(failureHtml(`Google OAuth returned: ${oauthError}`), {
      status: 400,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!code) {
    return NextResponse.json(
      { error: "Missing Google OAuth authorization code" },
      { status: 400 }
    );
  }

  const urlState = url.searchParams.get("state");
  const cookieState = request.cookies.get("gcal_oauth_state")?.value;

  if (!urlState || !cookieState || urlState !== cookieState) {
    return new NextResponse(
      failureHtml(
        "Invalid or missing OAuth state. Start the connection again from CloseOS while signed in."
      ),
      {
        status: 400,
        headers: { "content-type": "text/html; charset=utf-8" },
      }
    );
  }

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({
      version: "v2",
      auth: oauth2Client,
    });

    const profile = (await oauth2.userinfo.get()).data as GoogleUserInfo;
    const googleAccountEmail = profile.email?.toLowerCase() ?? null;

    if (!googleAccountEmail) {
      throw new Error("Google account email was not returned by OAuth profile API.");
    }

    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from("google_calendar_connections")
      .upsert(
        {
          business_id: BUSINESS_ID,
          access_token: tokens.access_token ?? null,
          refresh_token: tokens.refresh_token ?? null,
          scope: tokens.scope ?? null,
          token_type: tokens.token_type ?? null,
          expiry_date: tokens.expiry_date ?? null,
          google_account_email: googleAccountEmail,
          revoked_at: null,
          connected_at: now,
          updated_at: now,
        },
        {
          onConflict: "business_id",
        }
      );

    if (upsertError) {
      throw new Error(`Failed to save Google Calendar connection: ${upsertError.message}`);
    }

    const ok = new NextResponse(successHtml(googleAccountEmail), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    ok.cookies.set("gcal_oauth_state", "", { maxAge: 0, path: "/" });
    return ok;
  } catch (error) {
    return new NextResponse(
      failureHtml(
        error instanceof Error
          ? error.message
          : "Unknown error during Google Calendar OAuth callback."
      ),
      {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      }
    );
  }
}
