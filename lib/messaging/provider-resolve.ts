export type MessagingProviderId = "sentdm";

export function getResolvedMessagingProvider(): MessagingProviderId {
  const id = (process.env.CLOSEOS_MESSAGING_PROVIDER || "sentdm")
    .trim()
    .toLowerCase();
  if (id === "twilio") {
    console.warn(
      "[messaging] CLOSEOS_MESSAGING_PROVIDER=twilio is no longer supported; using sentdm."
    );
    return "sentdm";
  }
  if (id === "sentdm" || id === "") return "sentdm";
  throw new Error(
    `Unsupported CLOSEOS_MESSAGING_PROVIDER "${id}". Supported: sentdm`
  );
}

/** Maps legacy stored values (e.g. twilio rows) onto the active Sent.dm-only rail. */
export function parseMessagingProviderId(
  raw: string | null | undefined,
  fallback: MessagingProviderId
): MessagingProviderId {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "twilio") return "sentdm";
  if (s === "sentdm") return s;
  return fallback;
}
