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

/** @deprecated Prefer createSupabaseServiceRoleClient() for clarity */
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  {
    auth: { persistSession: false },
  }
);
