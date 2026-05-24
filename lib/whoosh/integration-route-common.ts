import "server-only";

import { NextResponse } from "next/server";
import {
  getWhooshAgendaFacilitySlugFromEnv,
  WHOOSH_FACILITY_SLUG_ENV,
} from "@/lib/whoosh/client";

/**
 * Non-secret agenda routing context — `endpoint`'s `{facility_slug}` equals {@link WHOOSH_FACILITY_SLUG_ENV}.
 * Never mirrors GET `/integration/api/club` slug unless you set env that way deliberately.
 */
export function whooshAgendaReportingFields(endpoint: string) {
  return {
    endpoint,
    agendaFacilitySlugFromEnv: getWhooshAgendaFacilitySlugFromEnv(),
    agendaFacilitySlugEnvVarName: WHOOSH_FACILITY_SLUG_ENV,
    separationNote:
      "Agenda `{facility_slug}` is WHOOSH_FACILITY_SLUG (env only). WHOOSH `/integration/api/club` identity (`clubIdentityFromApi`) may use a different slug—see GET `/api/integrations/whoosh/club`.",
  };
}

export type WhooshIntegrationEnvFlags = {
  WHOOSH_API_TOKEN: { configured: boolean };
  WHOOSH_API_BASE_URL: { configured: boolean };
} & Record<typeof WHOOSH_FACILITY_SLUG_ENV, { configured: boolean }>;

export function whooshIntegrationEnvFlags(): WhooshIntegrationEnvFlags {
  function flag(name: string): { configured: boolean } {
    const v = process.env[name];
    return { configured: Boolean(v && String(v).trim()) };
  }

  return {
    WHOOSH_API_TOKEN: flag("WHOOSH_API_TOKEN"),
    WHOOSH_API_BASE_URL: flag("WHOOSH_API_BASE_URL"),
    [WHOOSH_FACILITY_SLUG_ENV]: flag(WHOOSH_FACILITY_SLUG_ENV),
  };
}

export function missingWhooshEnvList(flags: WhooshIntegrationEnvFlags): string[] {
  const missing: string[] = [];
  if (!flags.WHOOSH_API_TOKEN.configured) missing.push("WHOOSH_API_TOKEN");
  if (!flags.WHOOSH_API_BASE_URL.configured) missing.push("WHOOSH_API_BASE_URL");
  if (!flags[WHOOSH_FACILITY_SLUG_ENV].configured) {
    missing.push(WHOOSH_FACILITY_SLUG_ENV);
  }
  return missing;
}

export function sanitizeWhooshUpstreamSnippet(text: string, maxLen: number): string {
  let t = text.replace(/\r\n/g, "\n").trim();
  t = t.replace(/authorization\s*:\s*\S+/gi, "authorization: [redacted]");
  t = t.replace(/bearer\s+\S+/gi, "bearer [redacted]");
  t = t.replace(/token["']?\s*[:=]\s*["']?[^"'\s]+/gi, "token: [redacted]");
  if (t.length > maxLen) {
    return `${t.slice(0, maxLen)}…`;
  }
  return t;
}

export function describeWhooshTransportError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Request to Whoosh could not be completed.";
  }
  const parts = [error.message.trim() || "Request to Whoosh could not be completed."];
  const c = error.cause;
  if (c instanceof Error && c.message) {
    parts.push(c.message.trim());
  }
  return sanitizeWhooshUpstreamSnippet(parts.filter(Boolean).join(" "), 280);
}

function tryWhooshStructuredErrorDetail(bodyText: string): string | undefined {
  try {
    const o = JSON.parse(bodyText) as { errors?: unknown };
    const first = Array.isArray(o.errors) ? o.errors[0] : null;
    if (first && typeof first === "object" && first !== null) {
      const detail = (first as { detail?: unknown }).detail;
      if (typeof detail === "string" && detail.trim()) {
        return sanitizeWhooshUpstreamSnippet(detail.trim(), 220);
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function summarizeWhooshAgendaHttpFailure(input: {
  status: number;
  statusText: string;
  bodyText: string;
  resourceLabel: string;
}): string {
  if (input.status === 401 || input.status === 403) {
    return "Whoosh declined the request (authentication or authorization).";
  }
  if (input.status === 404) {
    const whooshMsg = tryWhooshStructuredErrorDetail(input.bodyText);
    if (whooshMsg) {
      return `Whoosh (${input.resourceLabel}, 404): ${whooshMsg}`;
    }
    return `Whoosh reported no ${input.resourceLabel} for this facility or date.`;
  }
  if (input.status >= 500) {
    return "Whoosh returned a server error.";
  }
  const snippet = sanitizeWhooshUpstreamSnippet(input.bodyText, 180);
  if (snippet) {
    return snippet;
  }
  return input.statusText || "Request failed.";
}

export function whooshMissingEnvResponse(
  flags: ReturnType<typeof whooshIntegrationEnvFlags>,
  missing: string[],
  endpoint: string,
  extra?: Record<string, unknown>
) {
  return NextResponse.json(
    {
      ok: false,
      ...(extra ?? {}),
      whoosh: {
        env: flags,
        configured: false,
        missingEnv: missing,
        endpoint,
      },
      error: {
        endpoint,
        summary: `Missing environment variables: ${missing.join(", ")}.`,
      },
    },
    { status: 503 }
  );
}
