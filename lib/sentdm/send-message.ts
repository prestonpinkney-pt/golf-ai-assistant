/** Sent.dm v3 outbound — template wrapper or direct conversational SMS (`SENTDM_SEND_MODE`). */

import { randomUUID } from "node:crypto";

import { normalizePhone } from "@/lib/messaging/phone";

export type SentDmChannel = "sms" | "rcs";

export type SentDmSendMode = "template" | "direct_text";

/** How outbound `direct_text` authenticates (`template` sends always use `x-api-key`). */
export type SentDmAuthMode = "x_api_key" | "bearer";

export type SentDmApiKeySource = "SENTDM_API_KEY" | "SENT_API_KEY" | "SENT_DM_API_KEY";

export type SentDmResolvedApiKey = {
  apiKey: string;
  sourceEnvVar: SentDmApiKeySource;
};

export type SentDmSendMessageInput = {
  to: string;
  message: string;
  channel?: SentDmChannel;
  name?: string | null;
  businessName?: string | null;
  templateId?: string;
  /** Sending profile / sender id when your Sent.dm account requires it. */
  senderId?: string | null;
  /**
   * Sent.dm `Idempotency-Key` header — prefer outbound DB row UUID when available.
   * Defaults to random UUID when omitted.
   */
  idempotencyKey?: string | null;
};

export type SentDmSendMessageResult = {
  success: boolean;
  provider: string;
  external_id: string | null;
  status: string;
  raw?: unknown;
};

function deriveDisplayName(input: { name?: string | null; to: string }) {
  const trimmed = input.name?.trim();
  if (trimmed) return trimmed;
  return "there";
}

/** Resolved outbound mode — defaults to template for backward compatibility. */
export function resolveSentDmSendMode(): SentDmSendMode {
  const raw = process.env.SENTDM_SEND_MODE?.trim().toLowerCase();
  if (raw === "direct_text") return "direct_text";
  return "template";
}

/** Defaults to `x_api_key` to match working Sent.dm integrations (see `SENTDM_AUTH_MODE`). */
export function resolveSentDmAuthMode(): SentDmAuthMode {
  const raw = process.env.SENTDM_AUTH_MODE?.trim().toLowerCase();
  if (raw === "bearer") return "bearer";
  return "x_api_key";
}

function resolveSentDmApiKey(): SentDmResolvedApiKey | null {
  const sentdm = process.env.SENTDM_API_KEY?.trim();
  if (sentdm)
    return { apiKey: sentdm, sourceEnvVar: "SENTDM_API_KEY" };
  const sent = process.env.SENT_API_KEY?.trim();
  if (sent) return { apiKey: sent, sourceEnvVar: "SENT_API_KEY" };
  const legacy = process.env.SENT_DM_API_KEY?.trim();
  if (legacy) return { apiKey: legacy, sourceEnvVar: "SENT_DM_API_KEY" };
  return null;
}

function shouldDebugSentDmOutbound(): boolean {
  return (
    process.env.NODE_ENV === "development" ||
    process.env.CLOSEOS_DEBUG_SENTDM_OUTBOUND === "true"
  );
}

/** Template parameters: mirror AI reply text into keys common on Sent.dm placeholder dashboards. */
export function buildAiReplySentDmTemplateParameters(
  aiReplyText: string,
  displayName: string,
  businessName: string
): Record<string, string> {
  const t = aiReplyText.trim();
  const params: Record<string, string> = {
    name: displayName,
    business_name: businessName,
    businessName,
    // Dynamic reply — many templates use one of these slot names
    body: t,
    text: t,
    content: t,
    message: t,
    reply: t,
    sms_body: t,
    smsBody: t,
    response: t,
    ai_reply: t,
    aiReply: t,
  };

  const extra =
    process.env.SENT_DM_TEMPLATE_REPLY_KEYS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  for (const k of extra) {
    params[k] = t;
  }

  return params;
}

export type SentDmV3OutboundPayloadArgs = {
  to: string;
  message: string;
  channel: SentDmChannel;
  name?: string | null;
  businessName?: string | null;
  templateId: string;
  senderId?: string | null;
};

/**
 * Builds JSON body for template sends: POST https://api.sent.dm/v3/messages
 * Exported for tests — runtime uses {@link sendSentDmMessage}.
 */
export function buildSentDmV3MessagesPayload(
  input: SentDmV3OutboundPayloadArgs
): Record<string, unknown> {
  const trimmedMessage = (input.message ?? "").trim();
  if (!trimmedMessage) {
    throw new Error("`message` is required");
  }

  const tid = input.templateId?.trim();
  if (!tid) {
    throw new Error("`templateId` is required for template sends");
  }

  const displayName = deriveDisplayName({ name: input.name, to: input.to });
  const resolvedBusinessName =
    input.businessName?.trim() ||
    process.env.CLOSEOS_BUSINESS_NAME?.trim() ||
    "";

  const channelFlag = input.channel === "rcs" ? "rcs" : "sms";

  const senderIdResolved =
    input.senderId?.trim() ||
    process.env.SENTDM_SENDER_ID?.trim() ||
    null;

  const payload: Record<string, unknown> = {
    to: [input.to],
    channel: [channelFlag === "rcs" ? "rcs" : "sms"],
    template: {
      id: tid,
      parameters: buildAiReplySentDmTemplateParameters(
        trimmedMessage,
        displayName,
        resolvedBusinessName
      ),
    },
  };

  if (senderIdResolved) {
    payload.sender_id = senderIdResolved;
  }

  return payload;
}

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Recipient for Sent.dm direct_text — normalized E.164, single element in payload `to` array. */
export function normalizeOutboundSentDmRecipientE164(toRaw: string): string {
  const candidate = normalizePhone(toRaw.trim());
  if (!candidate || !E164_RE.test(candidate)) {
    throw new Error(
      "`to` must be a reachable phone number in E.164 (e.g. +15103756639)"
    );
  }
  return candidate;
}

/** Direct conversational SMS — `to` as string array + `text` body (matches template-style `to: [...]` ). */
export function buildSentDmDirectTextPayload(
  to: string,
  text: string
): { to: string[]; text: string } {
  const t = text.trim();
  if (!t) throw new Error("`text` is required");
  const e164 = normalizeOutboundSentDmRecipientE164(to.trim());
  return { to: [e164], text: t };
}

function redactOutboundPayloadForLog(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const clone = { ...payload };
  if ("template" in clone && clone.template && typeof clone.template === "object") {
    const tpl = { ...(clone.template as Record<string, unknown>) };
    if (tpl.parameters && typeof tpl.parameters === "object") {
      const p = { ...(tpl.parameters as Record<string, string>) };
      const keys = Object.keys(p);
      for (const k of keys) {
        const v = p[k];
        if (typeof v === "string" && v.length > 80) {
          p[k] = `${v.slice(0, 80)}… (${v.length} chars)`;
        }
      }
      tpl.parameters = p;
    }
    clone.template = tpl;
  }
  if (
    Array.isArray(clone.to) &&
    clone.to.every((x) => typeof x === "string")
  ) {
    clone.to = (clone.to as string[]).map((num) =>
      num.length <= 10 ? "+••••••••••" : `${num.slice(0, 5)}••••${num.slice(-2)}`,
    );
  }
  if (typeof clone.text === "string" && clone.text.length > 120) {
    clone.text = `${(clone.text as string).slice(0, 120)}… (${(clone.text as string).length} chars)`;
  }
  return clone;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && v !== null ?
      (v as Record<string, unknown>)
    : null;
}

/** Parse Sent.dm v3 send response (`success`, `data.recipients`, etc.). */
export function parseSentDmV3SendResponse(data: unknown): {
  success: boolean;
  external_id: string | null;
  status: string;
} {
  const root = asRecord(data);
  if (!root) {
    return { success: false, external_id: null, status: "unknown" };
  }

  const failed = root.success === false;
  if (failed) {
    return { success: false, external_id: null, status: "error" };
  }

  const inner = asRecord(root.data);
  const status =
    typeof inner?.status === "string" ? inner.status : "queued";

  let external_id: string | null = null;

  const rec = inner?.recipients;
  if (Array.isArray(rec) && rec.length > 0) {
    const first = asRecord(rec[0]);
    if (first) {
      if (typeof first.message_id === "string") external_id = first.message_id;
      else if (typeof first.messageId === "string") external_id = first.messageId;
      else if (typeof first.id === "string") external_id = first.id;
    }
  }

  if (!external_id) {
    if (typeof root.message_id === "string") external_id = root.message_id;
    else if (typeof root.messageId === "string") external_id = root.messageId;
    else if (typeof root.id === "string") external_id = root.id;
  }

  return {
    success: root.success !== false,
    external_id,
    status,
  };
}

function resolvedTemplateIdForSend(input: SentDmSendMessageInput): string {
  return (
    input.templateId?.trim() ||
    process.env.SENT_DM_TEMPLATE_ID?.trim() ||
    ""
  );
}

/**
 * Sends SMS or RCS via Sent.dm `POST https://api.sent.dm/v3/messages`.
 *
 * - `SENTDM_SEND_MODE=direct_text` (SMS): `{ to: ["+..."], text: "..." }` + `Idempotency-Key` +
 *   auth per `SENTDM_AUTH_MODE` (default **`x_api_key`**: `x-api-key`; or **`bearer`**: `Authorization: Bearer`).
 * - `SENTDM_SEND_MODE=template` (default): template payload + **`x-api-key`** (existing integrations).
 * - SMS `direct_text` + RCS: falls through to template + `x-api-key`.
 *
 * API key resolution order: {@link process.env.SENTDM_API_KEY} → `SENT_API_KEY` → `SENT_DM_API_KEY`.
 */
export async function sendSentDmMessage(
  input: SentDmSendMessageInput
): Promise<SentDmSendMessageResult> {
  const keyResolved = resolveSentDmApiKey();
  if (!keyResolved) {
    throw new Error(
      "Missing Sent.dm API key (set SENTDM_API_KEY, SENT_API_KEY, or SENT_DM_API_KEY)"
    );
  }

  const { apiKey } = keyResolved;
  const { to, message, name, businessName } = input;
  const channelFlag: SentDmChannel =
    input.channel === "rcs" ? "rcs" : "sms";

  const trimmedMessage = (message ?? "").trim();
  if (!trimmedMessage) {
    throw new Error("`message` is required");
  }

  const senderId =
    input.senderId?.trim() ||
    process.env.SENTDM_SENDER_ID?.trim() ||
    null;

  const mode = resolveSentDmSendMode();
  const authModeDirect = resolveSentDmAuthMode();
  const debug = shouldDebugSentDmOutbound();
  const idempotencyKey =
    input.idempotencyKey?.trim() || randomUUID();

  let payload: Record<string, unknown>;
  let headers: Record<string, string>;

  const useDirectConversationalSms =
    mode === "direct_text" && channelFlag === "sms";

  if (useDirectConversationalSms) {
    payload = {
      ...buildSentDmDirectTextPayload(to, trimmedMessage),
    };
    headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(authModeDirect === "bearer" ?
        { Authorization: `Bearer ${apiKey}` }
      : { "x-api-key": apiKey }),
    };
  } else {
    if (mode === "direct_text" && channelFlag === "rcs") {
      if (debug) {
        console.log(
          "[sentdm-outbound] direct_text mode: using template send for RCS channel"
        );
      }
    }
    const tid = resolvedTemplateIdForSend(input);
    if (!tid) {
      throw new Error(
        "Template sends require SENT_DM_TEMPLATE_ID (or pass templateId). Required for template mode and for RCS when SENTDM_SEND_MODE=direct_text."
      );
    }
    payload = buildSentDmV3MessagesPayload({
      to,
      message: trimmedMessage,
      channel: channelFlag,
      name,
      businessName,
      templateId: tid,
      senderId,
    });
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    };
  }

  if (debug) {
    console.log("[sentdm-outbound] send mode:", mode);
    console.log(
      "[sentdm-outbound] transport:",
      useDirectConversationalSms ? "direct_text" : "template"
    );
    if (useDirectConversationalSms) {
      console.log(
        "[sentdm-outbound] SENTDM_AUTH_MODE (applied to direct_text):",
        authModeDirect
      );
    } else {
      console.log(
        "[sentdm-outbound] SENTDM_AUTH_MODE (applied to template path): always x_api_key header"
      );
    }
    console.log(
      "[sentdm-outbound] API key loaded from env var:",
      keyResolved.sourceEnvVar
    );
    console.log("[sentdm-outbound] message preview:", {
      length: trimmedMessage.length,
      preview: trimmedMessage.slice(0, 220),
    });
    const safePayloadRaw = redactOutboundPayloadForLog(payload);
    const safePayload =
      useDirectConversationalSms ?
        {
          ...safePayloadRaw,
          _credentials: `[redacted: ${authModeDirect === "bearer" ? "Authorization Bearer" : "x-api-key header"}]`,
        }
      : safePayloadRaw;
    console.log(
      "[sentdm-outbound] request payload:",
      JSON.stringify(safePayload, null, 2)
    );
    if (useDirectConversationalSms) {
      console.log("[sentdm-outbound] Idempotency-Key:", `${idempotencyKey.slice(0, 12)}…`);
    }
  }

  const response = await fetch("https://api.sent.dm/v3/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  let data: unknown = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }

  if (debug) {
    console.log(
      "[sentdm-outbound] response:",
      typeof data === "object" && data !== null ?
        JSON.stringify(data, null, 2)
      : String(data)
    );
  }

  if (!response.ok) {
    throw new Error(
      `Sent.dm send failed (${response.status}): ${JSON.stringify(data)}`
    );
  }

  const parsed = parseSentDmV3SendResponse(data);
  if (parsed.success === false) {
    throw new Error(`Sent.dm send rejected: ${JSON.stringify(data)}`);
  }

  return {
    success: true,
    provider: "sentdm",
    external_id: parsed.external_id,
    status: parsed.status,
    raw: data,
  };
}
