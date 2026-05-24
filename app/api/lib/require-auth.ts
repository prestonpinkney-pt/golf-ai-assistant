import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import { BUSINESS_ID } from "../config";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";

export class ApiAuthError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = "ApiAuthError";
  }
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function isCronAuthorizedRequest(request: NextRequest | Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  return timingSafeEqualStrings(header, `Bearer ${secret}`);
}

export function isInternalSecretAuthorizedRequest(
  request: NextRequest | Request
): boolean {
  const internal = process.env.INTERNAL_API_SECRET;
  const cron = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return false;
  if (internal && timingSafeEqualStrings(header, `Bearer ${internal}`)) return true;
  if (cron && timingSafeEqualStrings(header, `Bearer ${cron}`)) return true;
  return false;
}

/**
 * Gate that allows only callers presenting CRON_SECRET as `Authorization: Bearer`.
 * Returns a JSON 401 response when unauthorized, otherwise null.
 */
export function gateCron(request: NextRequest | Request): NextResponse | null {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured on the server" },
      { status: 500 }
    );
  }
  if (isCronAuthorizedRequest(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Gate for internal/server-to-server calls. Allows INTERNAL_API_SECRET, CRON_SECRET,
 * or an authenticated dashboard user.
 */
export async function gateInternalOrBusinessUser(
  request: NextRequest | Request
): Promise<NextResponse | null> {
  if (isInternalSecretAuthorizedRequest(request)) return null;
  try {
    await requireBusinessUser();
    return null;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }
}

export type BusinessUserContext = {
  user: User;
  businessId: string;
  role: string;
};

/**
 * Validates Supabase session cookies and an active `business_users` row for Primetime.
 * Call from Route Handlers after optional cron bypass.
 */
export async function requireBusinessUser(): Promise<BusinessUserContext> {
  const cookieStore = await cookies();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options as CookieOptions | undefined)
            );
          } catch {
            // ignore read-only context
          }
        },
      },
    }
  );

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    throw new ApiAuthError(401, "Not authenticated");
  }

  const admin = createSupabaseServiceRoleClient();
  const { data: row, error } = await admin
    .from("business_users")
    .select("business_id, role, active")
    .eq("user_id", user.id)
    .eq("business_id", BUSINESS_ID)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    console.error("business_users lookup failed:", error.message);
    throw new ApiAuthError(403, "Workspace membership could not be verified");
  }

  if (!row) {
    throw new ApiAuthError(403, "Not authorized for this CloseOS workspace");
  }

  return {
    user,
    businessId: row.business_id as string,
    role: row.role as string,
  };
}

/** Primary workspace business id for dashboard server pages (single-tenant Primetime). */
export async function getPrimaryBusinessIdForUser(userId: string): Promise<string | null> {
  const admin = createSupabaseServiceRoleClient();
  const { data: row, error } = await admin
    .from("business_users")
    .select("business_id")
    .eq("user_id", userId)
    .eq("business_id", BUSINESS_ID)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    console.error("getPrimaryBusinessIdForUser:", error.message);
    return null;
  }

  return (row?.business_id as string | undefined) ?? null;
}

/** Returns a JSON error response or null when the caller may proceed. */
export async function gateBusinessUser(): Promise<NextResponse | null> {
  try {
    await requireBusinessUser();
    return null;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }
}

/** Cron / internal jobs may use `Authorization: Bearer ${CRON_SECRET}` instead of a user session. */
export async function gateBusinessUserOrCron(
  request: NextRequest | Request
): Promise<NextResponse | null> {
  if (isCronAuthorizedRequest(request)) return null;
  try {
    await requireBusinessUser();
    return null;
  } catch (e) {
    if (e instanceof ApiAuthError) {
      return NextResponse.json({ error: e.message }, { status: e.statusCode });
    }
    throw e;
  }
}
