export function mapLeadSource(rawSource?: string): string {
  const source = (rawSource || "").toLowerCase();

  if (source === "website" || source === "website_form" || source === "web") {
    return "website_form";
  }

  if (source === "instagram" || source === "ig") {
    return "instagram";
  }

  if (source === "mailchimp") {
    return "mailchimp";
  }

  if (source === "square") {
    return "square";
  }

  if (source === "chat" || source === "chat_widget" || source === "sms") {
    return "chat_widget";
  }

  return "manual";
}

export function mapLeadType(message?: string): string {
  const text = (message || "").toLowerCase();

  if (text.includes("lesson") || text.includes("swing") || text.includes("1 hour") || text.includes("30 min")) {
    return "lesson";
  }

  if (text.includes("event") || text.includes("party") || text.includes("birthday") || text.includes("corporate") || text.includes("group")) {
    return "event";
  }

  if (text.includes("membership") || text.includes("member") || text.includes("monthly")) {
    return "membership";
  }

  if (text.includes("junior")) {
    return "junior_program";
  }

  if (text.includes("corporate booking")) {
    return "corporate_booking";
  }

  return "general_question";
}

export function defaultLeadStage(): string {
  return "new_inquiry";
}

export function defaultLeadStatus(): string {
  return "new";
}

export function defaultLeadTemperature(): string {
  return "cold";
}

export function defaultLeadPriority(): string {
  return "medium";
}