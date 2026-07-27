import { NextResponse } from "next/server";
import { getBusinessConfig } from "@/app/api/config";
import {
  gateInternalOrBusinessUser,
  isInternalSecretAuthorizedRequest,
  requireBusinessUser,
} from "@/app/api/lib/require-auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import {
  getResolvedMessagingProvider,
  parseMessagingProviderId,
} from "@/lib/messaging/provider-resolve";
import { resolveBusinessMessagingConfigFromDb } from "@/lib/business-messaging-config";
import { evaluateMessagingPhoneOwnership } from "@/lib/business-messaging-phone-ownership";

type ConfigPayload = {
  businessId?: unknown;
  slug?: unknown;
  name?: unknown;
  websiteDomain?: unknown;
  assistantName?: unknown;
  smsFromNumber?: unknown;
  supportResponse?: unknown;
  afterHoursResponse?: unknown;
  menuResponse?: unknown;
  optOutResponse?: unknown;
  autoSendEnabled?: unknown;
  minConfidence?: unknown;
  maxSmsLength?: unknown;
  phoneNumbers?: unknown;
  active?: unknown;
  aiSourceOfTruth?: unknown;
  optInResponse?: unknown;
  businessTimezone?: unknown;
  supportWeekdays?: unknown;
  supportOpenLocal?: unknown;
  supportCloseLocal?: unknown;
  riskyInboundTerms?: unknown;
  riskyResponseTerms?: unknown;
  messagingProvider?: unknown;
};

type BusinessMessagingNumberRow = {
  phone_number: string | null;
};

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function cleanNumber(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isLikelyE164Phone(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

function cleanPhoneNumbers(input: ConfigPayload): string[] {
  const numbers = new Set<string>();
  const fromNumber = cleanString(input.smsFromNumber);

  if (fromNumber) numbers.add(fromNumber);

  if (Array.isArray(input.phoneNumbers)) {
    input.phoneNumbers.forEach((value) => {
      const phone = cleanString(value);
      if (phone) numbers.add(phone);
    });
  }

  return [...numbers];
}

function cleanSupportWeekdays(value: unknown): number[] {
  if (Array.isArray(value)) {
    const nums = value.filter(
      (x): x is number => typeof x === "number" && x >= 1 && x <= 7
    );
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  if (typeof value === "string" && value.trim()) {
    const nums = value
      .split(/[,\s]+/)
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 7);
    return [...new Set(nums)].sort((a, b) => a - b);
  }
  return [1, 2, 3, 4, 5];
}

/** Supabase `time` column: `HH:mm` → `HH:mm:00`. */
function toPgTime(value: string | null): string | null {
  if (!value?.trim()) return null;
  const s = value.trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) return `${s}:00`;
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(s)) return s;
  return null;
}

function badRequest(message: string) {
  return NextResponse.json({ success: false, error: message }, { status: 400 });
}

/** `undefined` = omit column (legacy clients); `null` = use built-in defaults in app layer. */
function parseRiskyTermsForDb(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const lines = value
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return lines.length > 0 ? lines : null;
  }
  if (Array.isArray(value)) {
    const lines = value
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    return lines.length > 0 ? lines : null;
  }
  return undefined;
}

export async function GET(req: Request) {
  const denied = await gateInternalOrBusinessUser(req);
  if (denied) return denied;

  const supabase = createSupabaseServiceRoleClient();
  const url = new URL(req.url);
  const paramBusinessId = url.searchParams.get("business_id")?.trim() || null;
  const businessSlug = url.searchParams.get("slug")?.trim() || undefined;

  let businessId: string;

  if (isInternalSecretAuthorizedRequest(req)) {
    businessId = paramBusinessId || getBusinessConfig().id;
  } else {
    const ctx = await requireBusinessUser();
    businessId = paramBusinessId || ctx.businessId;
    if (paramBusinessId && paramBusinessId !== ctx.businessId) {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }
  }

  const config = await resolveBusinessMessagingConfigFromDb(supabase, {
    businessId,
    businessSlug,
  });

  const { data: numbers, error: numbersError } = await supabase
    .from("business_messaging_numbers")
    .select("id, phone_number, provider, channel, active, created_at")
    .eq("business_id", config.id)
    .order("created_at", { ascending: true });

  if (numbersError) {
    return NextResponse.json(
      { success: false, error: numbersError.message },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    config,
    phone_numbers: numbers ?? [],
  });
}

export async function PUT(req: Request) {
  const denied = await gateInternalOrBusinessUser(req);
  if (denied) return denied;

  let payload: ConfigPayload;
  try {
    payload = (await req.json()) as ConfigPayload;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const supabase = createSupabaseServiceRoleClient();
  const fallbackBiz = getBusinessConfig();

  let businessId: string;
  let slug: string;
  let name: string;
  let websiteDomain: string;

  if (isInternalSecretAuthorizedRequest(req)) {
    businessId = cleanString(payload.businessId) || fallbackBiz.id;
    slug = cleanString(payload.slug) || fallbackBiz.slug;
    name = cleanString(payload.name) || fallbackBiz.name;
    websiteDomain = cleanString(payload.websiteDomain) || fallbackBiz.websiteDomain;
  } else {
    const ctx = await requireBusinessUser();
    businessId = cleanString(payload.businessId) || ctx.businessId;
    if (businessId !== ctx.businessId) {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }
    const rowFallback = await resolveBusinessMessagingConfigFromDb(supabase, {
      businessId,
    });
    slug = cleanString(payload.slug) || rowFallback.slug;
    name = cleanString(payload.name) || rowFallback.name;
    websiteDomain = cleanString(payload.websiteDomain) || rowFallback.websiteDomain;
  }

  const assistantName =
    cleanString(payload.assistantName) || `${name} AI Assistant`;
  const active = cleanBoolean(payload.active, true);
  const smsFromNumber = cleanString(payload.smsFromNumber);
  const phoneNumbers = cleanPhoneNumbers(payload);

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return badRequest("`slug` must be lowercase words separated by hyphens");
  }

  const invalidPhone = phoneNumbers.find((phone) => !isLikelyE164Phone(phone));
  if (invalidPhone) {
    return badRequest(`Invalid E.164 phone number: ${invalidPhone}`);
  }

  const minConfidence = Math.max(
    0,
    Math.min(1, cleanNumber(payload.minConfidence, 0.75))
  );
  const maxSmsLength = Math.max(
    1,
    Math.round(cleanNumber(payload.maxSmsLength, 600))
  );
  const aiSourceOfTruth =
    typeof payload.aiSourceOfTruth === "string"
      ? payload.aiSourceOfTruth.trim()
      : "";
  if (!aiSourceOfTruth) {
    return badRequest("`aiSourceOfTruth` is required");
  }
  const supportWeekdays = cleanSupportWeekdays(payload.supportWeekdays);
  const businessTimezone = cleanString(payload.businessTimezone);
  const supportOpenLocal = toPgTime(cleanString(payload.supportOpenLocal));
  const supportCloseLocal = toPgTime(cleanString(payload.supportCloseLocal));

  const riskyInboundTerms = parseRiskyTermsForDb(payload.riskyInboundTerms);
  const riskyResponseTerms = parseRiskyTermsForDb(payload.riskyResponseTerms);

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .upsert(
      {
        id: businessId,
        slug,
        name,
        website_domain: websiteDomain,
        active,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    )
    .select("id")
    .single();

  if (businessError || !business) {
    return NextResponse.json(
      {
        success: false,
        error: businessError?.message || "Business upsert failed",
      },
      { status: 500 }
    );
  }

  const messagingProvider = parseMessagingProviderId(
    typeof payload.messagingProvider === "string" ? payload.messagingProvider : undefined,
    getResolvedMessagingProvider()
  );

  const messagingConfigRow: Record<string, unknown> = {
    business_id: business.id,
    assistant_name: assistantName,
    messaging_provider: messagingProvider,
    sms_from_number: smsFromNumber,
    support_response: cleanString(payload.supportResponse),
    after_hours_response: cleanString(payload.afterHoursResponse),
    menu_response: cleanString(payload.menuResponse),
    opt_out_response: cleanString(payload.optOutResponse),
    ai_source_of_truth: aiSourceOfTruth,
    opt_in_response: cleanString(payload.optInResponse),
    business_timezone: businessTimezone,
    support_weekdays: supportWeekdays,
    support_open_local: supportOpenLocal,
    support_close_local: supportCloseLocal,
    auto_send_enabled: cleanBoolean(payload.autoSendEnabled, true),
    min_confidence: minConfidence,
    max_sms_length: maxSmsLength,
    active,
    updated_at: new Date().toISOString(),
  };

  if (riskyInboundTerms !== undefined) {
    messagingConfigRow.risky_inbound_terms = riskyInboundTerms;
  }
  if (riskyResponseTerms !== undefined) {
    messagingConfigRow.risky_response_terms = riskyResponseTerms;
  }

  const { error: configError } = await supabase
    .from("business_messaging_configs")
    .upsert(messagingConfigRow, { onConflict: "business_id" });

  if (configError) {
    return NextResponse.json(
      { success: false, error: configError.message },
      { status: 500 }
    );
  }

  const { data: existingNumberRows, error: existingNumbersError } = await supabase
    .from("business_messaging_numbers")
    .select("phone_number")
    .eq("business_id", business.id)
    .eq("active", true);

  if (existingNumbersError) {
    return NextResponse.json(
      { success: false, error: existingNumbersError.message },
      { status: 500 }
    );
  }

  for (const phoneNumber of phoneNumbers) {
    const { data: existingNumber, error: existingNumberLookupError } = await supabase
      .from("business_messaging_numbers")
      .select("business_id")
      .eq("phone_number", phoneNumber)
      .maybeSingle();

    if (existingNumberLookupError) {
      return NextResponse.json(
        {
          success: false,
          error: existingNumberLookupError.message,
          phone_number: phoneNumber,
        },
        { status: 500 }
      );
    }

    const ownership = evaluateMessagingPhoneOwnership({
      requestingBusinessId: business.id,
      existingOwnerBusinessId:
        existingNumber && typeof existingNumber.business_id === "string" ?
          existingNumber.business_id
        : null,
    });

    if (!ownership.ok) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Phone number is already registered to another business and cannot be claimed.",
          phone_number: phoneNumber,
          code: ownership.reason,
        },
        { status: 409 }
      );
    }

    const { error: numberError } = await supabase
      .from("business_messaging_numbers")
      .upsert(
        {
          business_id: business.id,
          phone_number: phoneNumber,
          provider: messagingProvider,
          channel: "sms",
          active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "phone_number" }
      );

    if (numberError) {
      return NextResponse.json(
        { success: false, error: numberError.message, phone_number: phoneNumber },
        { status: 500 }
      );
    }
  }

  const submittedNumbers = new Set(phoneNumbers);
  const removedNumbers = ((existingNumberRows ?? []) as BusinessMessagingNumberRow[])
    .map((row) => cleanString(row.phone_number))
    .filter((phone): phone is string => Boolean(phone))
    .filter((phone) => !submittedNumbers.has(phone));

  for (const phoneNumber of removedNumbers) {
    const { error: deactivateError } = await supabase
      .from("business_messaging_numbers")
      .update({
        active: false,
        updated_at: new Date().toISOString(),
      })
      .eq("business_id", business.id)
      .eq("phone_number", phoneNumber);

    if (deactivateError) {
      return NextResponse.json(
        {
          success: false,
          error: deactivateError.message,
          phone_number: phoneNumber,
        },
        { status: 500 }
      );
    }
  }

  const config = await resolveBusinessMessagingConfigFromDb(supabase, {
    businessId: business.id,
  });

  return NextResponse.json({
    success: true,
    config,
    phone_numbers: phoneNumbers,
  });
}
