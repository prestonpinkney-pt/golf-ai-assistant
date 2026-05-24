/**
 * Shared Square REST helpers (Customer Directory, bulk retrieve).
 */

export const SQUARE_API_VERSION = "2025-01-23";

export class SquareApiError extends Error {
  status: number;
  path: string;
  responseText: string;

  constructor(input: { path: string; status: number; responseText: string }) {
    super(`Square request failed for ${input.path}: ${input.responseText.slice(0, 500)}`);
    this.name = "SquareApiError";
    this.path = input.path;
    this.status = input.status;
    this.responseText = input.responseText;
  }
}

export function isSquareCustomerNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = error instanceof SquareApiError ? error.status : null;
  const text =
    error instanceof SquareApiError ? error.responseText : error.message;
  return (
    status === 404 ||
    (/\bNOT_FOUND\b/i.test(text) && /\bcustomer\b/i.test(text))
  );
}

export type SquareCustomerRecord = {
  id: string;
  given_name?: string;
  family_name?: string;
  email_address?: string;
  phone_number?: string;
  company_name?: string;
  created_at?: string;
  updated_at?: string;
  reference_id?: string;
};

export function getSquareApiBaseUrl(environment?: string): string {
  const env = (environment ?? process.env.SQUARE_ENVIRONMENT ?? "production").trim();
  return env === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function squareFetch<T>(
  path: string,
  accessToken: string,
  init?: RequestInit,
  environment?: string
): Promise<T> {
  const maxAttempts = 3;
  const base = getSquareApiBaseUrl(environment);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Square-Version": SQUARE_API_VERSION,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const text = await response.text();

    if (response.ok) {
      return text ? (JSON.parse(text) as T) : ({} as T);
    }

    const isRateLimited =
      response.status === 429 || text.includes("RATE_LIMITED");

    if (isRateLimited && attempt < maxAttempts) {
      await sleep(1500 * attempt);
      continue;
    }

    throw new SquareApiError({ path, status: response.status, responseText: text });
  }

  throw new Error(`Square request failed for ${path}`);
}

/** List all customers from GET /v2/customers with cursor pagination. */
export async function listAllSquareCustomers(
  accessToken: string,
  environment?: string
): Promise<SquareCustomerRecord[]> {
  const customers: SquareCustomerRecord[] = [];
  let cursor: string | undefined;

  do {
    const qs = new URLSearchParams({ limit: "100" });
    if (cursor) qs.set("cursor", cursor);

    const data = await squareFetch<{
      customers?: SquareCustomerRecord[];
      cursor?: string;
    }>(`/v2/customers?${qs.toString()}`, accessToken, undefined, environment);

    for (const c of data.customers ?? []) {
      if (c?.id) customers.push(c);
    }

    cursor = data.cursor;
    if (cursor) await sleep(300);
  } while (cursor);

  return customers;
}

export async function retrieveSquareCustomerById(
  accessToken: string,
  customerId: string,
  environment?: string
): Promise<SquareCustomerRecord | null> {
  const data = await squareFetch<{ customer?: SquareCustomerRecord }>(
    `/v2/customers/${customerId}`,
    accessToken,
    undefined,
    environment
  );
  return data.customer ?? null;
}

export async function bulkRetrieveSquareCustomers(
  accessToken: string,
  customerIds: string[],
  environment?: string
): Promise<Map<string, SquareCustomerRecord>> {
  const map = new Map<string, SquareCustomerRecord>();

  for (let i = 0; i < customerIds.length; i += 100) {
    const batch = customerIds.slice(i, i + 100);
    if (batch.length === 0) continue;

    const data = await squareFetch<{ customers?: SquareCustomerRecord[] }>(
      "/v2/customers/bulk-retrieve",
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({ customer_ids: batch }),
      },
      environment
    );

    for (const c of data.customers ?? []) {
      if (c?.id) map.set(c.id, c);
    }

    await sleep(300);
  }

  return map;
}

/** Strip Square customer to fields safe to persist in raw_payload. */
export function sanitizeSquareCustomerPayload(
  customer: SquareCustomerRecord
): Record<string, unknown> {
  return {
    id: customer.id,
    given_name: customer.given_name ?? null,
    family_name: customer.family_name ?? null,
    email_address: customer.email_address ?? null,
    phone_number: customer.phone_number ?? null,
    company_name: customer.company_name ?? null,
    reference_id: customer.reference_id ?? null,
    created_at: customer.created_at ?? null,
    updated_at: customer.updated_at ?? null,
  };
}
