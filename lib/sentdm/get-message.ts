import "server-only";

function resolvedApiKey(): string {
  return (
    process.env.SENTDM_API_KEY?.trim() ||
    process.env.SENT_API_KEY?.trim() ||
    process.env.SENT_DM_API_KEY?.trim() ||
    ""
  );
}

export type SentDmMessageDetails = {
  id: string;
  from: string | null;
  to: string | null;
  text: string | null;
  channel: string | null;
  /** Sent.dm direction e.g. INBOUND / OUTBOUND */
  direction: string | null;
  /** Raw lifecycle status e.g. RECEIVED, DELIVERED */
  statusRaw: string | null;
  raw: unknown;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

/** Pull text from Sent.dm message JSON (v3 shapes vary). */
export function extractTextFromMessagePayload(raw: unknown): string | null {
  const pickStr = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

  const data = asRecord(raw);
  if (!data) return null;

  const dd = asRecord(data.data);
  const nestedMessageBody = dd ? asRecord(dd.message_body) : null;
  const rootMessageBody = asRecord(data.message_body);

  const text =
    pickStr(nestedMessageBody?.content) ??
    pickStr(rootMessageBody?.content) ??
    pickStr(dd?.text) ??
    pickStr(dd?.body) ??
    pickStr(dd?.message) ??
    pickStr(data.text) ??
    pickStr(data.body) ??
    pickStr(data.message) ??
    null;

  if (text) return text;

  const r = data;

  const direct = [
    r.text,
    r.body,
    r.content,
    r.message_body,
    r.messageBody,
  ].find((x) => typeof x === "string" && x.trim()) as string | undefined;
  if (direct?.trim()) return direct.trim();

  const nested = asRecord(r.message);
  if (nested) {
    const t = [
      nested.text,
      nested.body,
      nested.content,
    ].find((x) => typeof x === "string" && x.trim()) as string | undefined;
    if (t?.trim()) return t.trim();
  }

  const template = asRecord(r.template);
  if (template) {
    const params = asRecord(template.parameters);
    if (params) {
      const tp = [
        params.body,
        params.message,
        params.text,
        params.content,
      ].find((x) => typeof x === "string" && x.trim()) as string | undefined;
      if (tp?.trim()) return tp.trim();
    }
  }

  const nestedData = asRecord(r.data);
  if (nestedData) {
    const d = [nestedData.text, nestedData.body, nestedData.message].find(
      (x) => typeof x === "string" && x.trim()
    ) as string | undefined;
    if (d?.trim()) return d.trim();
  }

  return null;
}

function pickPhone(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function unwrapSentDmMessageRecord(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw);
  if (!root) return {};
  const inner = asRecord(root.data);
  return inner ?? root;
}

function extractDirection(inner: Record<string, unknown>): string | null {
  const v =
    inner.direction ??
    inner.message_direction ??
    (asRecord(inner.message)?.direction as unknown);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function extractStatusRaw(inner: Record<string, unknown>): string | null {
  const v =
    inner.status ??
    inner.message_status ??
    inner.delivery_status ??
    (asRecord(inner.message)?.status as unknown);
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Fetches a single message from Sent.dm REST API.
 * Endpoint: `GET https://api.sent.dm/v3/messages/{messageId}` with `x-api-key`.
 */
export async function fetchSentDmMessageById(
  messageId: string
): Promise<{ ok: true; details: SentDmMessageDetails } | { ok: false; error: string }> {
  const apiKey = resolvedApiKey();
  if (!apiKey) {
    return { ok: false, error: "missing_sentdm_api_key" };
  }

  const url = `https://api.sent.dm/v3/messages/${encodeURIComponent(messageId.trim())}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "x-api-key": apiKey,
      },
    });
  } catch (e: unknown) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "sentdm_fetch_network_error",
    };
  }

  const data = await res.json().catch(() => ({}));

  if (
    process.env.NODE_ENV === "development" ||
    process.env.CLOSEOS_DEBUG_SENTDM_INBOUND === "true"
  ) {
    console.log(
      "[sentdm-message-lookup] raw response:",
      JSON.stringify(data, null, 2)
    );
  }

  const rec = asRecord(data);

  if (!res.ok) {
    const msg =
      typeof rec?.message === "string"
        ? rec.message
        : typeof rec?.error === "string"
          ? rec.error
        : `http_${res.status}`;
    return {
      ok: false,
      error: `sentdm_message_lookup_http_${res.status}: ${msg}`,
    };
  }

  const inner = unwrapSentDmMessageRecord(rec ?? data);

  const text =
    extractTextFromMessagePayload(inner) ??
    extractTextFromMessagePayload(rec ?? data);

  const from =
    pickPhone(inner, [
      "from",
      "from_number",
      "inbound_number",
      "sender",
      "phone",
      "fromPhone",
    ]) ??
    pickPhone(asRecord(rec) ?? {}, [
      "from",
      "inbound_number",
    ]);

  const to =
    pickPhone(inner, [
      "to",
      "to_number",
      "outbound_number",
      "recipient",
    ]) ??
    pickPhone(asRecord(rec) ?? {}, ["to", "outbound_number"]);

  const channelRaw = inner.channel ?? (asRecord(rec)?.channel as unknown);
  const channel =
    typeof channelRaw === "string" ? channelRaw : null;

  const direction = extractDirection(inner);
  const statusRaw = extractStatusRaw(inner);

  const id =
    (typeof inner.id === "string" && inner.id) ||
    (typeof inner.messageId === "string" && inner.messageId) ||
    (typeof rec?.id === "string" && rec.id) ||
    (typeof rec?.messageId === "string" && rec.messageId) ||
    messageId;

  return {
    ok: true,
    details: {
      id,
      from,
      to,
      text,
      channel,
      direction,
      statusRaw,
      raw: data,
    },
  };
}
