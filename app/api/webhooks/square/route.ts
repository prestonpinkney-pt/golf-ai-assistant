import { createClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";
import { decryptToken } from "@/lib/square-token-crypto";
import { verifySquareWebhookSignature } from "@/lib/square-webhook-signature";
import { BUSINESS_ID } from "../../config";
const SQUARE_VERSION = "2025-01-23";

type SquareWebhookBody = {
  type?: string;
  event_id?: string;
  merchant_id?: string;
  data?: {
    id?: string;
    type?: string;
    object?: {
      payment?: {
        id: string;
        status: string;
        created_at: string;
        updated_at?: string;
        amount_money?: {
          amount?: number;
          currency?: string;
        };
        customer_id?: string;
        order_id?: string;
        buyer_email_address?: string;
      };
    };
  };
};

type SquareConnection = {
  access_token_encrypted: string;
  location_id: string | null;
  revoked_at: string | null;
};

type SquareOrder = {
  id: string;
  customer_id?: string;
  line_items?: Array<{
    name?: string;
    quantity?: string;
    total_money?: {
      amount?: number;
      currency?: string;
    };
    variation_name?: string;
  }>;
};

function getSupabaseAdmin() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
  });
}

function getSquareApiBaseUrl() {
  return process.env.SQUARE_ENVIRONMENT === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

async function squareFetch<T>(
  path: string,
  accessToken: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetch(`${getSquareApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Square request failed for ${path}: ${text}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

function classifyPurchase(itemNames: string[]) {
  const text = itemNames.join(" ").toLowerCase();

  if (
    text.includes("primetime associate") ||
    text.includes("primetime peak access") ||
    text.includes("primetime quarter") ||
    text.includes("membership") ||
    text.includes("member") ||
    text.includes("monthly")
  ) {
    return {
      category: "membership",
      opportunityType: "membership",
      intent: "membership_activity",
    };
  }

  if (
    text.includes("lesson") ||
    text.includes("instruction") ||
    text.includes("coaching")
  ) {
    return {
      category: "lesson",
      opportunityType: "lesson",
      intent: "instruction_interest",
    };
  }

  if (
    text.includes("simulator") ||
    text.includes("bay") ||
    text.includes("trackman") ||
    text.includes("practice")
  ) {
    return {
      category: "simulator",
      opportunityType: "lesson",
      intent: "practice_activity",
    };
  }

  if (
    text.includes("clinic") ||
    text.includes("junior") ||
    text.includes("camp")
  ) {
    return {
      category: "clinic",
      opportunityType: "event",
      intent: "program_interest",
    };
  }

  if (
    text.includes("event") ||
    text.includes("outing") ||
    text.includes("party") ||
    text.includes("corporate")
  ) {
    return {
      category: "event",
      opportunityType: "event",
      intent: "group_event_interest",
    };
  }

  return {
    category: "unknown",
    opportunityType: "reactivation",
    intent: "purchase_activity",
  };
}

async function getSquareConnection(supabase: ReturnType<typeof getSupabaseAdmin>) {
  const { data, error } = await supabase
    .from("square_connections")
    .select("access_token_encrypted, location_id, revoked_at")
    .eq("business_id", BUSINESS_ID)
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? "Square connection not found");
  }

  const connection = data as SquareConnection;

  if (connection.revoked_at) {
    throw new Error("Square connection has been revoked");
  }

  return connection;
}

async function fetchOrderIfNeeded(input: {
  accessToken: string;
  orderId?: string | null;
}) {
  if (!input.orderId) return null;

  const data = await squareFetch<{ order?: SquareOrder }>(
    `/v2/orders/${input.orderId}`,
    input.accessToken
  );

  return data.order ?? null;
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
    const notificationUrl =
      process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ??
      new URL("/api/webhooks/square", request.nextUrl.origin).toString();

    if (process.env.NODE_ENV === "production") {
      if (!signatureKey) {
        return NextResponse.json(
          { error: "Square webhook is not configured (missing SQUARE_WEBHOOK_SIGNATURE_KEY)" },
          { status: 500 }
        );
      }
      const sig =
        request.headers.get("x-square-hmacsha256-signature") ??
        request.headers.get("X-Square-Hmacsha256-Signature");
      if (
        !verifySquareWebhookSignature({
          rawBody,
          signatureHeader: sig,
          notificationUrl,
          signatureKey,
        })
      ) {
        return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
      }
    } else if (signatureKey) {
      const sig =
        request.headers.get("x-square-hmacsha256-signature") ??
        request.headers.get("X-Square-Hmacsha256-Signature");
      if (
        !verifySquareWebhookSignature({
          rawBody,
          signatureHeader: sig,
          notificationUrl,
          signatureKey,
        })
      ) {
        return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
      }
    }

    const body = JSON.parse(rawBody) as SquareWebhookBody;

    if (
      body.type !== "payment.created" &&
      body.type !== "payment.updated"
    ) {
      return NextResponse.json({
        ignored: true,
        reason: "Unsupported webhook type",
        type: body.type,
      });
    }

    const payment = body.data?.object?.payment;

    if (!payment?.id) {
      return NextResponse.json(
        { error: "Missing payment object" },
        { status: 400 }
      );
    }

    if (payment.status !== "COMPLETED") {
      return NextResponse.json({
        ignored: true,
        reason: "Payment is not completed",
        status: payment.status,
      });
    }

    const amountCents = payment.amount_money?.amount ?? 0;

    if (amountCents <= 0) {
      return NextResponse.json({
        ignored: true,
        reason: "Payment amount is zero",
      });
    }

    const supabase = getSupabaseAdmin();
    const connection = await getSquareConnection(supabase);
    const accessToken = decryptToken(connection.access_token_encrypted);

    const order = await fetchOrderIfNeeded({
      accessToken,
      orderId: payment.order_id,
    });

    const externalCustomerId =
      payment.customer_id ?? order?.customer_id ?? null;

    let customerProfileId: string | null = null;

    if (externalCustomerId) {
      const { data: profile, error: profileError } = await supabase
        .from("customer_profiles")
        .upsert(
          {
            business_id: BUSINESS_ID,
            source: "square",
            external_customer_id: externalCustomerId,
            email: payment.buyer_email_address ?? undefined,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "source,external_customer_id",
          }
        )
        .select("id")
        .single();

      if (profileError) {
        return NextResponse.json(
          {
            error: "Failed to upsert customer profile",
            details: profileError.message,
          },
          { status: 500 }
        );
      }

      customerProfileId = profile.id;
    }

    const itemNames =
      order?.line_items
        ?.map((item) => item.name)
        .filter((name): name is string => Boolean(name)) ?? [];

    const classification = classifyPurchase(itemNames);

    const { error: purchaseError } = await supabase
      .from("purchase_history")
      .upsert(
        {
          business_id: BUSINESS_ID,
          customer_profile_id: customerProfileId,
          source: "square",
          external_payment_id: payment.id,
          external_order_id: payment.order_id ?? null,
          external_customer_id: externalCustomerId,
          amount_cents: amountCents,
          currency: payment.amount_money?.currency ?? "USD",
          purchase_category: classification.category,
          opportunity_type: classification.opportunityType,
          detected_intent: classification.intent,
          item_names: itemNames,
          occurred_at: payment.created_at,
          raw_payload: {
            webhook: body,
            payment,
            order,
            classification,
          },
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "source,external_payment_id",
        }
      );

    if (purchaseError) {
      return NextResponse.json(
        {
          error: "Failed to save purchase from webhook",
          details: purchaseError.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      eventId: body.event_id,
      type: body.type,
      paymentId: payment.id,
      amountCents,
      externalCustomerId,
      customerProfileId,
      revenueUpdated: true,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Square webhook failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}