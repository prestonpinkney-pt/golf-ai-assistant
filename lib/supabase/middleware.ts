import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function isPublicApiPath(pathname: string) {
  if (pathname.startsWith("/api/webhooks")) return true;
  if (pathname.startsWith("/api/cron")) return true;
  if (pathname === "/api/sentdm/webhook") return true;
  if (pathname.startsWith("/api/inbound")) return true;
  if (pathname.startsWith("/api/leads")) return true;
  if (pathname === "/api/integrations/google-calendar/oauth/callback") return true;
  if (pathname === "/api/integrations/square/callback") return true;
  if (pathname.startsWith("/api/auth")) return true;
  return false;
}

function isProtectedApiPath(pathname: string) {
  if (pathname.startsWith("/api/opportunities")) return true;
  if (pathname.startsWith("/api/revenue")) return true;
  if (pathname.startsWith("/api/integrations")) return true;
  return false;
}

function isCronAuthorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

function isProtectedPage(pathname: string) {
  const prefixes = ["/dashboard", "/opportunities", "/outbound", "/messages"];
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function forwardAuthCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach(({ name, value }) => {
    to.cookies.set(name, value);
  });
  return to;
}

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", pathname);

  let supabaseResponse = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({
            request: { headers: requestHeaders },
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options as CookieOptions | undefined)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (isProtectedApiPath(pathname) && !isPublicApiPath(pathname)) {
    if (isCronAuthorized(request)) {
      return supabaseResponse;
    }
    if (!user) {
      const denied = NextResponse.json({ error: "Not authenticated" }, { status: 401 });
      return forwardAuthCookies(supabaseResponse, denied);
    }
  }

  if (isProtectedPage(pathname) && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    const redirect = NextResponse.redirect(url);
    return forwardAuthCookies(supabaseResponse, redirect);
  }

  if (pathname === "/login" && user) {
    const next = request.nextUrl.searchParams.get("next");
    const safeNext =
      next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
    const url = request.nextUrl.clone();
    url.pathname = safeNext;
    url.search = "";
    const redirect = NextResponse.redirect(url);
    return forwardAuthCookies(supabaseResponse, redirect);
  }

  return supabaseResponse;
}
