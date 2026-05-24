import type { NextRequest } from "next/server";
import {
  isCronAuthorizedRequest,
  isInternalSecretAuthorizedRequest,
} from "@/app/api/lib/require-auth";

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Vercel cron (CRON_SECRET), ops secret, or legacy internal secret. */
export function isWebhookJobDrainAuthorized(request: NextRequest | Request): boolean {
  if (isCronAuthorizedRequest(request)) return true;
  if (isInternalSecretAuthorizedRequest(request)) return true;

  const dedicated = process.env.CLOSEOS_WEBHOOK_JOB_SECRET?.trim();
  if (!dedicated) return false;

  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  return timingSafeEqualStrings(auth, `Bearer ${dedicated}`);
}
