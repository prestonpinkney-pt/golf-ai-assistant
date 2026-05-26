import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const key = t.slice(0, eq).trim();
  let val = t.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}
const { createSupabaseServiceRoleClient } = await import("../lib/supabase/admin.ts");
const s = createSupabaseServiceRoleClient();
const biz = process.env.CLOSEOS_BUSINESS_ID;
for (const c of [
  "metadata",
  "counts_toward_pipeline",
  "pipeline_category",
  "offer_key",
  "revenue_review_required",
  "source",
  "targeting_profile_id",
]) {
  const { error } = await s
    .from("ai_opportunities")
    .select(`id,${c}`)
    .eq("business_id", biz)
    .limit(1);
  console.log(c, error ? `MISSING: ${error.message}` : "ok");
}
