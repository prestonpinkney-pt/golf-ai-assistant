import { NextResponse } from "next/server";
import { sendMessage } from "../../../lib/send-message";
import { resolveOutboundSmsConsentGate } from "@/lib/messaging/outbound-sms-consent";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import { gateInternalOrBusinessUser } from "../lib/require-auth";

const MAX_MESSAGE_LENGTH = 1600;

function isLikelyE164Phone(value: unknown): value is string {
  return typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value.trim());
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export async function POST(req: Request) {
  const denied = await gateInternalOrBusinessUser(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const payload = (body ?? {}) as { to?: unknown; message?: unknown };
  const to = typeof payload.to === "string" ? payload.to.trim() : "";
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";

  if (!isLikelyE164Phone(to)) {
    return NextResponse.json(
      { error: "`to` must be an E.164 phone number (e.g. +15551234567)" },
      { status: 400 }
    );
  }

  if (!message) {
    return NextResponse.json(
      { error: "`message` is required" },
      { status: 400 }
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `\`message\` must be <= ${MAX_MESSAGE_LENGTH} characters` },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseServiceRoleClient();
    const { data: contact, error: contactLookupError } = await supabase
      .from("contacts")
      .select("sms_opt_out, cooling_off_until")
      .eq("phone", to)
      .maybeSingle();

    const consent = resolveOutboundSmsConsentGate({
      contact: contact
        ? {
            sms_opt_out: Boolean(contact.sms_opt_out),
            cooling_off_until:
              typeof contact.cooling_off_until === "string"
                ? contact.cooling_off_until
                : null,
          }
        : null,
      lookupError: contactLookupError,
    });
    if (!consent.allowed) {
      return NextResponse.json(
        { error: consent.error },
        { status: consent.status }
      );
    }

    const result = await sendMessage({
      channel: "sms",
      to,
      message,
    });

    return NextResponse.json({
      success: true,
      provider: result.provider,
      external_id: result.external_id,
      status: result.status,
    });
  } catch (error: unknown) {
    console.error("SMS error:", error);

    return NextResponse.json(
      {
        error: errorMessage(error, "Failed to send SMS"),
      },
      { status: 500 }
    );
  }
}
