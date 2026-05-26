export { isUninterestedMessage } from "@/lib/messaging/cooling-off";

export function isOptOutMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();

  const stopWords = [
    "stop",
    "stop all",
    "unsubscribe",
    "cancel",
    "end",
    "quit",
  ];

  return stopWords.includes(normalized);
}