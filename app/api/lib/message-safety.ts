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

export function isUninterestedMessage(text: string): boolean {
  const normalized = text.trim().toLowerCase();

  const uninterestedPhrases = [
    "not interested",
    "maybe later",
    "i'm good",
    "im good",
    "i’ll let you know",
    "i'll let you know",
    "not right now",
    "just looking",
  ];

  return uninterestedPhrases.some((phrase) => normalized.includes(phrase));
}