import "server-only";

import { randomUUID } from "node:crypto";

const SQUARE_VERSION = "2025-01-23";

function squareApiBase(): string {
  return process.env.SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function bearerToken(): string {
  const tok = process.env.SQUARE_ACCESS_TOKEN?.trim();
  if (!tok) throw new Error("Missing SQUARE_ACCESS_TOKEN for Checkout payment links.");
  return tok;
}

function locationId(): string {
  const loc = process.env.SQUARE_LOCATION_ID?.trim();
  if (!loc) throw new Error("Missing SQUARE_LOCATION_ID.");
  return loc;
}

export type SquarePaymentLinkCheckoutResult = {
  payment_link_id: string;
  payment_link_url: string;
  square_order_id: string | null;
};

/**
 * Hosted Checkout Payment Link — order carries metadata keyed for webhook resolution.
 */
export async function createSquareSimulatorBayBookingPaymentLink(opts: {
  amountDueCents: number;
  title: string;
  descriptionNote: string;
  metadataStringMap: Record<string, string>;
  referenceId?: string | null;
}): Promise<SquarePaymentLinkCheckoutResult> {
  const trimmedNote = opts.descriptionNote.trim().slice(0, 500);
  const body = {
    idempotency_key: randomUUID(),
    order: {
      location_id: locationId(),
      reference_id: opts.referenceId?.trim().slice(0, 191) ?? null,
      metadata: opts.metadataStringMap,
      line_items: [
        {
          name: opts.title.trim().slice(0, 140),
          quantity: "1",
          ...(trimmedNote ? { note: trimmedNote } : {}),
          base_price_money: {
            amount: Math.max(1, Math.round(opts.amountDueCents)),
            currency: "USD",
          },
        },
      ],
    },
    checkout_options: {
      /** Keep checkout terse for mobile SMS redirects. */
      ask_for_shipping_address: false,
    },
  };

  const res = await fetch(`${squareApiBase()}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearerToken()}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_VERSION,
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`Square payment link failed HTTP ${res.status}: ${rawText.slice(0, 1200)}`);
  }

  const parsed = JSON.parse(rawText) as {
    payment_link?: { id?: string; url?: string; order_id?: string };
    errors?: unknown;
  };

  const pl = parsed.payment_link;
  const id =
    typeof pl?.id === "string" && pl.id.trim() ? pl.id.trim() : "";
  const url =
    typeof pl?.url === "string" && pl.url.trim() ? pl.url.trim() : "";
  if (!id || !url) {
    throw new Error("Square payment link response missing payment_link.url/id.");
  }

  const order =
    typeof pl?.order_id === "string" && pl.order_id.trim() ? pl.order_id.trim()
    : null;

  return {
    payment_link_id: id,
    payment_link_url: url,
    square_order_id: order,
  };
}
