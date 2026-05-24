import "server-only";

/** Integration API — **confirmed working** club context (relative to `WHOOSH_API_BASE_URL`). */
export const WHOOSH_INTEGRATION_CLUB_PATH = "/integration/api/club";

/**
 * **Provisional** agenda URL builder — blocked until Whoosh supplies a canonical working slots/bookings
 * URL (path shape + facility identifier). Avoid iterating slug/id guesses in code without vendor docs.
 *
 * Tentative template:
 * `/integration/api/facility/{WHOOSH_FACILITY_SLUG}/agenda/{YYYY-MM-DD}/slots|bookings`
 *
 * `{facility_slug}` is {@link WHOOSH_FACILITY_SLUG_ENV} only — never inferred from GET
 * {@link WHOOSH_INTEGRATION_CLUB_PATH}. `agendaDate` must be `YYYY-MM-DD` (validated by callers).
 */
export function whooshIntegrationAgendaPath(
  agendaDate: string,
  segment: "slots" | "bookings"
): string {
  const { agendaFacilitySlug } = loadWhooshConfig();
  return `/integration/api/facility/${encodeURIComponent(agendaFacilitySlug)}/agenda/${encodeURIComponent(agendaDate)}/${segment}`;
}

/** Env var whose value is used as `{facility_slug}` on agenda URLs (non-secret slug). */
export const WHOOSH_FACILITY_SLUG_ENV = "WHOOSH_FACILITY_SLUG" as const;

type WhooshResolvedConfig = {
  apiToken: string;
  baseUrl: string;
  /** From {@link WHOOSH_FACILITY_SLUG_ENV}: used for `/integration/api/facility/...` and `/facilities/{slug}` helpers. Never take this from GET /integration/api/club. */
  agendaFacilitySlug: string;
};

function normalizeBaseUrl(raw: string) {
  return raw.replace(/\/+$/, "");
}

function loadWhooshConfig(): WhooshResolvedConfig {
  const apiToken = process.env.WHOOSH_API_TOKEN?.trim() ?? "";
  const baseUrlRaw = process.env.WHOOSH_API_BASE_URL?.trim() ?? "";
  const agendaFacilitySlug =
    process.env[WHOOSH_FACILITY_SLUG_ENV]?.trim() ?? "";

  const missing: string[] = [];
  if (!apiToken) missing.push("WHOOSH_API_TOKEN");
  if (!baseUrlRaw) missing.push("WHOOSH_API_BASE_URL");
  if (!agendaFacilitySlug) missing.push(WHOOSH_FACILITY_SLUG_ENV);

  if (missing.length) {
    throw new Error(
      `Whoosh API is not configured (missing: ${missing.join(", ")}).`
    );
  }

  return {
    apiToken,
    baseUrl: normalizeBaseUrl(baseUrlRaw),
    agendaFacilitySlug,
  };
}

/**
 * Returns true when all three Whoosh env vars are non-empty. Does not validate connectivity.
 * Never exposes the token value.
 */
export function isWhooshServerConfigured(): boolean {
  const token = process.env.WHOOSH_API_TOKEN?.trim();
  const base = process.env.WHOOSH_API_BASE_URL?.trim();
  const slug = process.env[WHOOSH_FACILITY_SLUG_ENV]?.trim();
  return Boolean(token && base && slug);
}

/**
 * Facility `{slug}` for `/integration/api/facility/{slug}/agenda/...` (same as {@link WHOOSH_FACILITY_SLUG_ENV}).
 * Never derived from GET /integration/api/club.
 */
export function getWhooshAgendaFacilitySlugFromEnv(): string {
  return loadWhooshConfig().agendaFacilitySlug;
}

/**
 * Non-secret config for logging or feature flags. Throws if Whoosh env is incomplete.
 */
export function getWhooshServerPublicConfig(): {
  baseUrl: string;
  agendaFacilitySlug: string;
} {
  const { baseUrl, agendaFacilitySlug } = loadWhooshConfig();
  return { baseUrl, agendaFacilitySlug };
}

function toAbsolutePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Prefix for facility-scoped Whoosh routes. Default pattern: `/facilities/{slug}/...`.
 * Adjust the path you pass to {@link whooshServerFetch} if your API uses a different layout.
 */
export function whooshFacilityPath(extraPath = ""): string {
  const { agendaFacilitySlug } = loadWhooshConfig();
  const base = `/facilities/${encodeURIComponent(agendaFacilitySlug)}`;
  if (!extraPath) return base;
  const suffix = toAbsolutePath(extraPath);
  return `${base}${suffix}`;
}

/**
 * Server-only `fetch` against `WHOOSH_API_BASE_URL`, with `Authorization: Bearer <WHOOSH_API_TOKEN>`.
 * Call only from Route Handlers, Server Actions, or other server code.
 */
export async function whooshServerFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const { apiToken, baseUrl } = loadWhooshConfig();
  const url = `${baseUrl}${toAbsolutePath(path)}`;

  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiToken}`);
  }
  if (init.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(url, { ...init, headers });
}

/**
 * Like {@link whooshServerFetch} but parses JSON on 2xx; throws on non-OK with a short body preview.
 */
export async function whooshServerJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await whooshServerFetch(path, init);
  const text = await res.text();

  if (!res.ok) {
    const preview = text.length > 400 ? `${text.slice(0, 400)}…` : text;
    throw new Error(`Whoosh API HTTP ${res.status}: ${preview || res.statusText}`);
  }

  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}
