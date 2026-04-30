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

export function isCronAuthorizedRequest(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
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
  request: NextRequest
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
