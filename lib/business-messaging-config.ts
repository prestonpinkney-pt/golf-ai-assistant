import { BUSINESS_ID, BUSINESS_NAME, BUSINESS_SLUG, WEBSITE_DOMAIN } from "@/app/api/config";
import {
  buildDefaultAiSourceOfTruth,
  DEFAULT_RISKY_INBOUND_TERMS,
  DEFAULT_RISKY_RESPONSE_TERMS,
} from "@/app/api/config/ai-source-of-truth";
import { isWithinConfiguredSupportHours } from "@/lib/messaging/support-hours";
import {
  getResolvedMessagingProvider,
  parseMessagingProviderId,
  type MessagingProviderId,
} from "@/lib/messaging/provider-resolve";
import type { SupabaseClient } from "@supabase/supabase-js";

export type BusinessMessagingConfig = {
  id: string;
  slug: string;
  name: string;
  websiteDomain: string;
  assistantName: string;
  messagingProvider: MessagingProviderId;
  smsFromNumber: string | null;
  autoSendEnabled: boolean;
  minConfidence: number;
  maxSmsLength: number;
  supportResponse: string;
  afterHoursResponse: string;
  menuResponse: string;
  optOutResponse: string;
  aiSourceOfTruth: string;
  optInResponse: string | null;
  businessTimezone: string | null;
  supportWeekdays: number[] | null;
  supportOpenLocal: string | null;
  supportCloseLocal: string | null;
  riskyInboundTerms: string[];
  riskyResponseTerms: string[];
};

type RawBusinessMessagingConfig = Partial<Omit<BusinessMessagingConfig, "messagingProvider">> & {
  inboundNumbers?: string[];
  messagingProvider?: string;
};

type BusinessRow = {
  id: string;
  slug: string | null;
  name: string | null;
  website_domain: string | null;
};

type BusinessMessagingConfigRow = {
  assistant_name: string | null;
  messaging_provider: string | null;
  sms_from_number: string | null;
  support_response: string | null;
  after_hours_response: string | null;
  menu_response: string | null;
  opt_out_response: string | null;
  auto_send_enabled: boolean | null;
  min_confidence: number | null;
  max_sms_length: number | null;
  ai_source_of_truth: string | null;
  opt_in_response: string | null;
  business_timezone: string | null;
  support_weekdays: number[] | null;
  support_open_local: string | null;
  support_close_local: string | null;
  risky_inbound_terms: string[] | null;
  risky_response_terms: string[] | null;
};

const DEFAULT_ASSISTANT_NAME = `${BUSINESS_NAME} AI Assistant`;

function cleanPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

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

function normalizeRiskyTermList(raw: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(raw)) {
    const list = raw
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return [...fallback];
}

function dbRiskyTermsColumn(value: string[] | null | undefined): string[] | undefined {
  if (!value || value.length === 0) return undefined;
  const list = value.map((s) => String(s).trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Postgres `time` often returns `"09:00:00"`; UI uses `HH:mm`. */
function formatLocalTimeForUi(value: string | null): string | null {
  if (!value || !value.trim()) return null;
  const parts = value.trim().split(":");
  if (parts.length >= 2) {
    const h = parts[0]!.padStart(2, "0");
    const m = parts[1]!.padStart(2, "0");
    return `${h}:${m}`;
  }
  return value.trim();
}

function readConfiguredBusinesses(): RawBusinessMessagingConfig[] {
  const raw = process.env.CLOSEOS_BUSINESSES_JSON?.trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn("[business-config] Invalid CLOSEOS_BUSINESSES_JSON:", error);
    return [];
  }
}

function buildDefaultConfig(): BusinessMessagingConfig {
  const assistantName =
    process.env.CLOSEOS_ASSISTANT_NAME?.trim() || DEFAULT_ASSISTANT_NAME;

  return {
    id: BUSINESS_ID,
    slug: BUSINESS_SLUG,
    name: BUSINESS_NAME,
    websiteDomain: WEBSITE_DOMAIN,
    assistantName,
    messagingProvider: getResolvedMessagingProvider(),
    smsFromNumber: cleanPhone(process.env.CLOSEOS_SMS_FROM_NUMBER),
    autoSendEnabled: cleanBoolean(process.env.CLOSEOS_AUTO_SEND_ENABLED, true),
    minConfidence: cleanNumber(process.env.CLOSEOS_MIN_AI_CONFIDENCE, 0.75),
    maxSmsLength: cleanNumber(process.env.CLOSEOS_MAX_SMS_LENGTH, 600),
    supportResponse:
      process.env.CLOSEOS_SUPPORT_RESPONSE?.trim() ||
      `Thanks for reaching out. This is ${assistantName}. I am routing your message to the ${BUSINESS_NAME} team so a person can help. If it is after hours, they will follow up during business hours.`,
    afterHoursResponse:
      process.env.CLOSEOS_AFTER_HOURS_RESPONSE?.trim() ||
      `Thanks for your message. The ${BUSINESS_NAME} team is away right now, but a person will follow up during business hours.`,
    menuResponse:
      process.env.CLOSEOS_MENU_RESPONSE?.trim() ||
      `This is ${assistantName}. I can help with:\n1. Lessons\n2. Tee times or simulator bookings\n3. Memberships\n4. Events or parties\n5. Pricing questions\nReply with a number, or reply HELP for a person.`,
    optOutResponse:
      process.env.CLOSEOS_OPT_OUT_RESPONSE?.trim() ||
      `You are unsubscribed from ${BUSINESS_NAME} text messages. Reply HELP if you need a person.`,
    aiSourceOfTruth: buildDefaultAiSourceOfTruth(BUSINESS_NAME),
    optInResponse: process.env.CLOSEOS_OPT_IN_RESPONSE?.trim() || null,
    businessTimezone: process.env.CLOSEOS_BUSINESS_TIMEZONE?.trim() || null,
    supportWeekdays: null,
    supportOpenLocal: process.env.CLOSEOS_SUPPORT_OPEN_LOCAL?.trim() || null,
    supportCloseLocal: process.env.CLOSEOS_SUPPORT_CLOSE_LOCAL?.trim() || null,
    riskyInboundTerms: [...DEFAULT_RISKY_INBOUND_TERMS],
    riskyResponseTerms: [...DEFAULT_RISKY_RESPONSE_TERMS],
  };
}

function normalizeConfig(
  raw: RawBusinessMessagingConfig,
  fallback: BusinessMessagingConfig
): BusinessMessagingConfig {
  const name = raw.name?.trim() || fallback.name;
  const assistantName = raw.assistantName?.trim() || `${name} AI Assistant`;

  return {
    id: raw.id?.trim() || fallback.id,
    slug: raw.slug?.trim() || fallback.slug,
    name,
    websiteDomain: raw.websiteDomain?.trim() || fallback.websiteDomain,
    assistantName,
    messagingProvider: parseMessagingProviderId(
      typeof raw.messagingProvider === "string" ? raw.messagingProvider : undefined,
      fallback.messagingProvider
    ),
    smsFromNumber: cleanPhone(raw.smsFromNumber) || fallback.smsFromNumber,
    autoSendEnabled: cleanBoolean(raw.autoSendEnabled, fallback.autoSendEnabled),
    minConfidence: Math.max(
      0,
      Math.min(1, cleanNumber(raw.minConfidence, fallback.minConfidence))
    ),
    maxSmsLength: Math.max(
      1,
      Math.round(cleanNumber(raw.maxSmsLength, fallback.maxSmsLength))
    ),
    supportResponse:
      raw.supportResponse?.trim() ||
      `Thanks for reaching out. This is ${assistantName}. I am routing your message to the ${name} team so a person can help. If it is after hours, they will follow up during business hours.`,
    afterHoursResponse:
      raw.afterHoursResponse?.trim() ||
      `Thanks for your message. The ${name} team is away right now, but a person will follow up during business hours.`,
    menuResponse:
      raw.menuResponse?.trim() ||
      `This is ${assistantName}. I can help with:\n1. Lessons\n2. Tee times or simulator bookings\n3. Memberships\n4. Events or parties\n5. Pricing questions\nReply with a number, or reply HELP for a person.`,
    optOutResponse:
      raw.optOutResponse?.trim() ||
      `You are unsubscribed from ${name} text messages. Reply HELP if you need a person.`,
    aiSourceOfTruth:
      raw.aiSourceOfTruth?.trim() || buildDefaultAiSourceOfTruth(name),
    optInResponse: raw.optInResponse !== undefined ? cleanString(raw.optInResponse) : fallback.optInResponse,
    businessTimezone: cleanString(raw.businessTimezone) ?? fallback.businessTimezone,
    supportWeekdays: Array.isArray(raw.supportWeekdays)
      ? raw.supportWeekdays.filter((d) => typeof d === "number" && d >= 1 && d <= 7)
      : fallback.supportWeekdays,
    supportOpenLocal: cleanString(raw.supportOpenLocal) ?? fallback.supportOpenLocal,
    supportCloseLocal: cleanString(raw.supportCloseLocal) ?? fallback.supportCloseLocal,
    riskyInboundTerms: normalizeRiskyTermList(raw.riskyInboundTerms, fallback.riskyInboundTerms),
    riskyResponseTerms: normalizeRiskyTermList(
      raw.riskyResponseTerms,
      fallback.riskyResponseTerms
    ),
  };
}

function normalizeDatabaseConfig(input: {
  business: BusinessRow;
  messagingConfig: BusinessMessagingConfigRow | null;
  fallback: BusinessMessagingConfig;
}): BusinessMessagingConfig {
  return normalizeConfig(
    {
      id: input.business.id,
      slug: input.business.slug ?? undefined,
      name: input.business.name ?? undefined,
      websiteDomain: input.business.website_domain ?? undefined,
      assistantName: input.messagingConfig?.assistant_name ?? undefined,
      smsFromNumber: input.messagingConfig?.sms_from_number ?? undefined,
      autoSendEnabled: input.messagingConfig?.auto_send_enabled ?? undefined,
      minConfidence: input.messagingConfig?.min_confidence ?? undefined,
      maxSmsLength: input.messagingConfig?.max_sms_length ?? undefined,
      supportResponse: input.messagingConfig?.support_response ?? undefined,
      afterHoursResponse: input.messagingConfig?.after_hours_response ?? undefined,
      menuResponse: input.messagingConfig?.menu_response ?? undefined,
      optOutResponse: input.messagingConfig?.opt_out_response ?? undefined,
      aiSourceOfTruth:
        input.messagingConfig?.ai_source_of_truth?.trim() ||
        buildDefaultAiSourceOfTruth(input.business.name ?? input.fallback.name),
      optInResponse: input.messagingConfig?.opt_in_response ?? undefined,
      businessTimezone: input.messagingConfig?.business_timezone ?? undefined,
      supportWeekdays: input.messagingConfig?.support_weekdays ?? undefined,
      supportOpenLocal: formatLocalTimeForUi(input.messagingConfig?.support_open_local ?? null) ?? undefined,
      supportCloseLocal: formatLocalTimeForUi(input.messagingConfig?.support_close_local ?? null) ?? undefined,
      riskyInboundTerms: dbRiskyTermsColumn(input.messagingConfig?.risky_inbound_terms),
      riskyResponseTerms: dbRiskyTermsColumn(input.messagingConfig?.risky_response_terms),
      messagingProvider: input.messagingConfig?.messaging_provider ?? undefined,
    },
    input.fallback
  );
}

async function lookupBusinessIdByPhone(
  supabase: SupabaseClient,
  phoneNumber: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("business_messaging_numbers")
    .select("business_id")
    .eq("phone_number", phoneNumber)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    console.warn("[business-config] Phone routing lookup failed:", error.message);
    return null;
  }

  return cleanString(data?.business_id);
}

async function lookupBusiness(
  supabase: SupabaseClient,
  input: {
    businessId?: unknown;
    businessSlug?: unknown;
    toNumber?: unknown;
  }
): Promise<BusinessRow | null> {
  const requestedToNumber = cleanPhone(input.toNumber);
  const routedBusinessId = requestedToNumber
    ? await lookupBusinessIdByPhone(supabase, requestedToNumber)
    : null;
  const requestedBusinessId = cleanString(input.businessId) || routedBusinessId;
  const requestedBusinessSlug = cleanString(input.businessSlug);

  if (!requestedBusinessId && !requestedBusinessSlug) {
    return null;
  }

  const attempts: { select: string; filterActive: boolean }[] = [
    { select: "id, slug, name, website_domain", filterActive: true },
    { select: "id, slug, name, website_domain", filterActive: false },
    { select: "id, slug, name", filterActive: true },
    { select: "id, slug, name", filterActive: false },
  ];

  let lastError: { message: string } | null = null;

  for (const { select, filterActive } of attempts) {
    let query = supabase.from("businesses").select(select);
    if (filterActive) {
      query = query.eq("active", true);
    }
    if (requestedBusinessId) {
      query = query.eq("id", requestedBusinessId);
    } else {
      query = query.eq("slug", requestedBusinessSlug!);
    }

    const { data, error } = await query.maybeSingle();
    if (!error) {
      const row = data as Partial<BusinessRow> | null;
      if (!row?.id) return null;
      return {
        id: row.id,
        slug: row.slug ?? null,
        name: row.name ?? null,
        website_domain:
          "website_domain" in row ? (row.website_domain ?? null) : null,
      };
    }

    const msg = error.message.toLowerCase();
    const missingColumn =
      msg.includes("does not exist") &&
      (msg.includes("website_domain") || msg.includes(".active"));
    lastError = error;
    if (!missingColumn) {
      console.warn("[business-config] Business lookup failed:", error.message);
      return null;
    }
  }

  if (lastError) {
    console.warn("[business-config] Business lookup failed:", lastError.message);
  }
  return null;
}

async function lookupMessagingConfig(
  supabase: SupabaseClient,
  businessId: string
): Promise<BusinessMessagingConfigRow | null> {
  const { data, error } = await supabase
    .from("business_messaging_configs")
    .select(
      [
        "assistant_name",
        "messaging_provider",
        "sms_from_number",
        "support_response",
        "after_hours_response",
        "menu_response",
        "opt_out_response",
        "auto_send_enabled",
        "min_confidence",
        "max_sms_length",
        "ai_source_of_truth",
        "opt_in_response",
        "business_timezone",
        "support_weekdays",
        "support_open_local",
        "support_close_local",
        "risky_inbound_terms",
        "risky_response_terms",
      ].join(", ")
    )
    .eq("business_id", businessId)
    .eq("active", true)
    .maybeSingle();

  if (error) {
    console.warn("[business-config] Messaging config lookup failed:", error.message);
    return null;
  }

  return data as BusinessMessagingConfigRow | null;
}

export function getDefaultBusinessMessagingConfig(): BusinessMessagingConfig {
  return buildDefaultConfig();
}

export function resolveBusinessMessagingConfig(input?: {
  businessId?: unknown;
  businessSlug?: unknown;
  toNumber?: unknown;
}): BusinessMessagingConfig {
  const fallback = buildDefaultConfig();
  const configured = readConfiguredBusinesses();
  const requestedBusinessId =
    typeof input?.businessId === "string" ? input.businessId.trim() : "";
  const requestedBusinessSlug =
    typeof input?.businessSlug === "string" ? input.businessSlug.trim() : "";
  const requestedToNumber = cleanPhone(input?.toNumber);

  const matched = configured.find((business) => {
    if (requestedBusinessId && business.id === requestedBusinessId) return true;
    if (requestedBusinessSlug && business.slug === requestedBusinessSlug) return true;
    if (
      requestedToNumber &&
      (business.smsFromNumber === requestedToNumber ||
        business.inboundNumbers?.includes(requestedToNumber))
    ) {
      return true;
    }
    return false;
  });

  return matched ? normalizeConfig(matched, fallback) : fallback;
}

export async function resolveBusinessMessagingConfigFromDb(
  supabase: SupabaseClient,
  input?: {
    businessId?: unknown;
    businessSlug?: unknown;
    toNumber?: unknown;
  }
): Promise<BusinessMessagingConfig> {
  const fallback = resolveBusinessMessagingConfig(input);
  const business = await lookupBusiness(supabase, input ?? {});

  if (!business) return fallback;

  const messagingConfig = await lookupMessagingConfig(supabase, business.id);
  return normalizeDatabaseConfig({
    business,
    messagingConfig,
    fallback,
  });
}

/** HELP reply: live-agent copy in hours, after-hours copy outside configured window. */
export function getHelpResponseForConfig(config: BusinessMessagingConfig): string {
  const within = isWithinConfiguredSupportHours({
    timezone: config.businessTimezone,
    weekdays: config.supportWeekdays,
    openLocal: config.supportOpenLocal,
    closeLocal: config.supportCloseLocal,
  });
  return within ? config.supportResponse : config.afterHoursResponse;
}

export function getOptInAcknowledgementForConfig(config: BusinessMessagingConfig): string {
  const custom = config.optInResponse?.trim();
  if (custom) return custom;
  return `You're subscribed to SMS from ${config.name}. Reply STOP to unsubscribe anytime.`;
}

/** Shape expected by `getAutoSendDecision` from tenant messaging settings. */
export function messagingAutoSendPolicy(config: BusinessMessagingConfig) {
  return {
    enabled: config.autoSendEnabled,
    minConfidence: config.minConfidence,
    maxSmsLength: config.maxSmsLength,
    riskyInboundTerms: config.riskyInboundTerms,
    riskyResponseTerms: config.riskyResponseTerms,
  };
}
