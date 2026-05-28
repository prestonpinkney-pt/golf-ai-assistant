import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function assertEnv(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return { url, key };
}

/** Service role client — server-only. Use only after verifying the caller (JWT or cron secret). */
export function createSupabaseServiceRoleClient(): SupabaseClient {
  const { url, key } = assertEnv();
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

let lazyAdminClient: SupabaseClient | null = null;

function getLazySupabaseAdmin(): SupabaseClient {
  if (!lazyAdminClient) {
    lazyAdminClient = createSupabaseServiceRoleClient();
  }
  return lazyAdminClient;
}

/**
 * @deprecated Prefer createSupabaseServiceRoleClient() — lazy proxy avoids build-time
 * createClient() when env vars are not available during `next build`.
 */
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getLazySupabaseAdmin();
    const value = Reflect.get(client, prop, client) as unknown;
    return typeof value === "function" ?
        (value as (...args: unknown[]) => unknown).bind(client)
      : value;
  },
});
