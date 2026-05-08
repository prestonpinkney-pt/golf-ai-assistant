import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { BUSINESS_ID } from "../../../config";
import { truthFieldsForDb } from "../../../lib/closeos-opportunity-truth";
import { gateBusinessUser } from "../../../lib/require-auth";

type MailchimpMember = {
  id: string;
  email_address?: string;
  status?: string;
  merge_fields?: Record<string, unknown>;
  tags?: Array<{
    id?: number;
    name?: string;
  }>;
};

type CustomerProfile = {
  id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  is_member?: boolean | null;
};

type ExtractedContact = {
  mailchimpMemberId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string | null;
  tags: string[];
  mergeFields: Record<string, unknown>;
  rawPayload: MailchimpMember;
};

type MatchResult = {
  customer: CustomerProfile;
  matchMethod: string;
  confidence: number;
  verified: boolean;
};

type MailchimpOpportunity = {
  recognizedOpportunity: string;
  opportunityType: string;
  playbook: string;
  priority: number;
  confidence: number;
  estimatedRevenueCents: number;
  signalSummary: string;
  nextBestAction: string;
  replyHandlingGoal: string;
  recommendedMessage: string;
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

function getMailchimpConfig() {
  const apiKey = process.env.MAILCHIMP_API_KEY;
  const serverPrefix = process.env.MAILCHIMP_SERVER_PREFIX;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;

  if (!apiKey || !serverPrefix || !audienceId) {
    throw new Error("Missing Mailchimp environment variables");
  }

  return {
    apiKey,
    serverPrefix,
    audienceId,
    baseUrl: `https://${serverPrefix}.api.mailchimp.com/3.0`,
  };
}

function normalizePhone(phone: unknown) {
  if (!phone || typeof phone !== "string") return null;

  const digitsOnly = phone.replace(/\D/g, "");

  if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`;
  }

  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    return `+${digitsOnly}`;
  }

  return null;
}

function hasUsablePhone(phone: string | null) {
  return Boolean(normalizePhone(phone));
}

function getStringMergeField(
  mergeFields: Record<string, unknown> | undefined,
  possibleKeys: string[]
) {
  if (!mergeFields) return null;

  for (const key of possibleKeys) {
    const value = mergeFields[key];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

function extractContact(member: MailchimpMember): ExtractedContact {
  const mergeFields = member.merge_fields ?? {};

  const firstName = getStringMergeField(mergeFields, [
    "FNAME",
    "FIRSTNAME",
    "FIRST_NAME",
  ]);

  const lastName = getStringMergeField(mergeFields, [
    "LNAME",
    "LASTNAME",
    "LAST_NAME",
  ]);

  const phoneRaw = getStringMergeField(mergeFields, [
    "PHONE",
    "PHONE_NUMBER",
    "MOBILE",
    "SMSPHONE",
    "SMS",
  ]);

  const phone = normalizePhone(phoneRaw);

  const tags =
    member.tags
      ?.map((tag) => tag.name)
      .filter((tagName): tagName is string => Boolean(tagName)) ?? [];

  return {
    mailchimpMemberId: member.id,
    email: member.email_address?.toLowerCase() ?? null,
    phone,
    firstName,
    lastName,
    status: member.status ?? null,
    tags,
    mergeFields,
    rawPayload: member,
  };
}

async function mailchimpFetch<T>(path: string) {
  const { apiKey, baseUrl } = getMailchimpConfig();

  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`anystring:${apiKey}`).toString(
        "base64"
      )}`,
      "Content-Type": "application/json",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Mailchimp request failed for ${path}: ${text}`);
  }

  return text ? (JSON.parse(text) as T) : ({} as T);
}

async function findBestCustomerMatch(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  contact: ExtractedContact;
}) {
  const { supabase, contact } = input;

  // Safest match: exact email + exact phone on the same customer profile.
  if (contact.email && contact.phone) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("id, email, phone, first_name, last_name, is_member")
      .eq("business_id", BUSINESS_ID)
      .ilike("email", contact.email)
      .eq("phone", contact.phone)
      .limit(2);

    if (error) throw error;

    const matches = (data ?? []) as CustomerProfile[];

    if (matches.length === 1) {
      return {
        customer: matches[0],
        matchMethod: "email_and_phone",
        confidence: 98,
        verified: true,
      };
    }

    // If multiple profiles have the same email+phone, do not auto-merge.
    if (matches.length > 1) {
      return null;
    }
  }

  // Email-only match is allowed only if exactly one customer has that email.
  if (contact.email) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("id, email, phone, first_name, last_name, is_member")
      .eq("business_id", BUSINESS_ID)
      .ilike("email", contact.email)
      .limit(2);

    if (error) throw error;

    const matches = (data ?? []) as CustomerProfile[];

    if (matches.length === 1) {
      return {
        customer: matches[0],
        matchMethod: "email_unique",
        confidence: 90,
        verified: false,
      };
    }

    if (matches.length > 1) {
      return null;
    }
  }

  // Phone-only match is allowed only if exactly one customer has that phone.
  if (contact.phone) {
    const { data, error } = await supabase
      .from("customer_profiles")
      .select("id, email, phone, first_name, last_name, is_member")
      .eq("business_id", BUSINESS_ID)
      .eq("phone", contact.phone)
      .limit(2);

    if (error) throw error;

    const matches = (data ?? []) as CustomerProfile[];

    if (matches.length === 1) {
      return {
        customer: matches[0],
        matchMethod: "phone_unique",
        confidence: 85,
        verified: false,
      };
    }

    if (matches.length > 1) {
      return null;
    }
  }

  return null;
}

async function createOrUpdateCustomerFromMailchimp(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  contact: ExtractedContact;
}) {
  const { supabase, contact } = input;

  const insertPayload = {
    business_id: BUSINESS_ID,
    source: "mailchimp",
    external_customer_id: `mailchimp:${contact.mailchimpMemberId}`,
    first_name: contact.firstName,
    last_name: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    identity_confidence: contact.email && contact.phone ? 80 : 65,
    identity_sources: ["mailchimp"],
    last_identity_enriched_at: new Date().toISOString(),
    ai_segment: "mailchimp_contact",
    ai_score: 0,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("customer_profiles")
    .upsert(insertPayload, {
      onConflict: "source,external_customer_id",
    })
    .select("id, email, phone, first_name, last_name, is_member")
    .single();

  if (error) throw error;

  return {
    customer: data as CustomerProfile,
    matchMethod: "mailchimp_created",
    confidence: contact.email && contact.phone ? 80 : 65,
    verified: false,
  };
}

function buildCustomerUpdatePayload(input: {
  existingCustomer: CustomerProfile;
  contact: ExtractedContact;
  confidence: number;
}) {
  const { existingCustomer, contact, confidence } = input;

  const payload: Record<string, unknown> = {
    identity_confidence: confidence,
    identity_sources: ["square", "mailchimp"],
    last_identity_enriched_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Never overwrite existing identity fields.
  // Only fill blanks.
  if (!existingCustomer.first_name && contact.firstName) {
    payload.first_name = contact.firstName;
  }

  if (!existingCustomer.last_name && contact.lastName) {
    payload.last_name = contact.lastName;
  }

  if (!existingCustomer.email && contact.email) {
    payload.email = contact.email;
  }

  if (!existingCustomer.phone && contact.phone) {
    payload.phone = contact.phone;
  }

  return payload;
}

function hasTag(tags: string[], tag: string) {
  return tags.some((candidate) => candidate.toLowerCase() === tag);
}

function hasAnyTag(tags: string[], candidates: string[]) {
  return candidates.some((candidate) => hasTag(tags, candidate));
}

function cleanMessage(message: string) {
  return message
    .replaceAll("Hi —", "Hi,")
    .replaceAll("Hi -", "Hi,")
    .replaceAll("Hi—", "Hi,")
    .replaceAll("Hi–", "Hi,")
    .replaceAll("Hello —", "Hello,")
    .replaceAll("Hello -", "Hello,")
    .replaceAll("Hey —", "Hey,")
    .replaceAll("Hey -", "Hey,")
    .replace(/\s+/g, " ")
    .trim();
}

function getLeadName(contact: ExtractedContact) {
  const fullName = [contact.firstName, contact.lastName]
    .filter(Boolean)
    .join(" ");

  return fullName || contact.email || contact.phone || "there";
}

function buildMailchimpOpportunity(input: {
  contact: ExtractedContact;
  isMember: boolean;
}) {
  const { contact, isMember } = input;
  const tags = contact.tags.map((tag) => tag.toLowerCase());
  const leadName = getLeadName(contact);

  const hasIntent = hasAnyTag(tags, [
    "intent:lesson",
    "intent:simulator",
    "intent:membership",
    "intent:event",
    "intent:clinic",
    "intent:junior",
    "intent:reactivation",
    "intent:general",
  ]);

  if (!hasIntent) return null;

  if (
    hasAnyTag(tags, [
      "do_not:contact",
      "do_not:text",
      "stage:not-interested",
      "stage:converted",
    ])
  ) {
    return null;
  }

  const hasLeadStage = hasAnyTag(tags, [
    "stage:new-lead",
    "stage:interested",
    "stage:lapsed",
  ]);

  if (!hasLeadStage) return null;

  if (!hasUsablePhone(contact.phone)) return null;

  if (hasTag(tags, "intent:lesson")) {
    return {
      recognizedOpportunity: "mailchimp_lesson_interest",
      opportunityType: "lesson",
      playbook: "lesson-lead-follow-up",
      priority: 82,
      confidence: 78,
      estimatedRevenueCents: 15000,
      signalSummary:
        "Mailchimp contact has clean lesson-interest tags and a reachable phone number.",
      nextBestAction:
        "Follow up about lesson goals and offer specific lesson availability.",
      replyHandlingGoal:
        "If they reply, ask what part of their game they want to improve and route them to lesson booking.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in golf lessons at Primetime Golf. What part of your game are you looking to work on right now?`
      ),
    } satisfies MailchimpOpportunity;
  }

  if (hasTag(tags, "intent:simulator")) {
    return {
      recognizedOpportunity: "mailchimp_simulator_interest",
      opportunityType: "simulator",
      playbook: "simulator-booking-follow-up",
      priority: 78,
      confidence: 74,
      estimatedRevenueCents: 7500,
      signalSummary:
        "Mailchimp contact has simulator or practice-interest tags and a reachable phone number.",
      nextBestAction:
        "Invite them to book simulator time or ask when they want to come in.",
      replyHandlingGoal:
        "If they reply, help them choose a simulator time or route them to booking.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in simulator time at Primetime Golf. Want me to send over a few good times to come in this week?`
      ),
    } satisfies MailchimpOpportunity;
  }

  if (hasTag(tags, "intent:event")) {
    return {
      recognizedOpportunity: "mailchimp_event_interest",
      opportunityType: "event",
      playbook: "event-lead-follow-up",
      priority: 80,
      confidence: 76,
      estimatedRevenueCents: 50000,
      signalSummary:
        "Mailchimp contact has event-interest tags and a reachable phone number.",
      nextBestAction:
        "Ask about group size, preferred date range, and event type.",
      replyHandlingGoal:
        "If they reply, qualify group size, date range, budget, and event purpose.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in hosting something at Primetime Golf. Are you looking at a private event, party, or group outing?`
      ),
    } satisfies MailchimpOpportunity;
  }

  if (hasTag(tags, "intent:junior")) {
    return {
      recognizedOpportunity: "mailchimp_junior_program_interest",
      opportunityType: "clinic",
      playbook: "junior-program-follow-up",
      priority: 76,
      confidence: 72,
      estimatedRevenueCents: 12500,
      signalSummary:
        "Mailchimp contact has junior golf or youth program-interest tags and a reachable phone number.",
      nextBestAction:
        "Follow up about junior clinic or program fit.",
      replyHandlingGoal:
        "If they reply, ask age, skill level, and preferred schedule.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in junior golf at Primetime Golf. What age is the junior golfer and are they brand new or already playing?`
      ),
    } satisfies MailchimpOpportunity;
  }

  if (hasTag(tags, "intent:clinic")) {
    return {
      recognizedOpportunity: "mailchimp_clinic_interest",
      opportunityType: "clinic",
      playbook: "clinic-follow-up",
      priority: 74,
      confidence: 70,
      estimatedRevenueCents: 10000,
      signalSummary:
        "Mailchimp contact has clinic-interest tags and a reachable phone number.",
      nextBestAction:
        "Send upcoming clinic details or ask which clinic they are interested in.",
      replyHandlingGoal:
        "If they reply, match them to the right clinic and enrollment step.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in a clinic at Primetime Golf. Want me to send over the next available clinic options?`
      ),
    } satisfies MailchimpOpportunity;
  }

  if (hasTag(tags, "intent:membership") && !isMember) {
    return {
      recognizedOpportunity: "mailchimp_membership_interest",
      opportunityType: "membership",
      playbook: "membership-lead-follow-up",
      priority: 79,
      confidence: 74,
      estimatedRevenueCents: 22000,
      signalSummary:
        "Mailchimp contact has membership-interest tags, is not marked as a member, and has a reachable phone number.",
      nextBestAction:
        "Follow up about membership fit and expected usage.",
      replyHandlingGoal:
        "If they reply, ask how often they plan to use Primetime Golf and route to membership options.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in membership at Primetime Golf. How often do you think you’d use the facility each month?`
      ),
    } satisfies MailchimpOpportunity;
  }

  if (hasTag(tags, "intent:reactivation")) {
    return {
      recognizedOpportunity: "mailchimp_reactivation_interest",
      opportunityType: "reactivation",
      playbook: "customer-reactivation",
      priority: 70,
      confidence: 68,
      estimatedRevenueCents: 7500,
      signalSummary:
        "Mailchimp contact has reactivation or lapsed-interest tags and a reachable phone number.",
      nextBestAction:
        "Send a warm return message and make it easy to book the next visit.",
      replyHandlingGoal:
        "If they reply, ask what they want to do next and route them to simulator, lesson, clinic, or event support.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, wanted to check in from Primetime Golf. Are you looking to get back in soon for practice, a lesson, or a round on the simulator?`
      ),
    } satisfies MailchimpOpportunity;
  }

  if (
    hasTag(tags, "intent:general") &&
    hasAnyTag(tags, ["source:website-form", "source:mailchimp-form"])
  ) {
    return {
      recognizedOpportunity: "mailchimp_general_lead",
      opportunityType: "general",
      playbook: "general-lead-follow-up",
      priority: 62,
      confidence: 60,
      estimatedRevenueCents: 7500,
      signalSummary:
        "Mailchimp contact has general lead intent from a form source and a reachable phone number.",
      nextBestAction:
        "Clarify what they are interested in before pitching a specific offer.",
      replyHandlingGoal:
        "If they reply, classify whether they want lessons, simulator time, membership, events, clinics, or junior programs.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, thanks for reaching out to Primetime Golf. Were you looking for lessons, simulator time, membership, or event info?`
      ),
    } satisfies MailchimpOpportunity;
  }

  return null;
}

async function upsertMailchimpOpportunity(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  customerProfileId: string;
  contact: ExtractedContact;
  opportunity: MailchimpOpportunity;
}) {
  const supabase = input.supabase as any;
  const now = new Date().toISOString();
  const truth = truthFieldsForDb(input.opportunity.recognizedOpportunity);

  const { data: existingRows, error: existingError } = await supabase
    .from("ai_opportunities")
    .select("id, status")
    .eq("business_id", BUSINESS_ID)
    .eq("customer_profile_id", input.customerProfileId)
    .eq("recognized_opportunity", input.opportunity.recognizedOpportunity)
    .eq("playbook", input.opportunity.playbook)
    .in("status", ["open", "queued", "launched", "replied"])
    .limit(1);

  if (existingError) {
    throw new Error(
      `Failed to check existing Mailchimp opportunity: ${existingError.message}`
    );
  }

  const existing = existingRows?.[0] as
    | { id: string; status: string }
    | undefined;

  if (existing?.status === "launched" || existing?.status === "replied") {
    const { error: refreshError } = await supabase
      .from("ai_opportunities")
      .update({
        priority: input.opportunity.priority,
        confidence: input.opportunity.confidence,
        ...truth,
        signal_summary: input.opportunity.signalSummary,
        next_best_action: input.opportunity.nextBestAction,
        reply_handling_goal: input.opportunity.replyHandlingGoal,
        last_evaluated_at: now,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (refreshError) {
      throw new Error(
        `Failed to refresh active Mailchimp opportunity: ${refreshError.message}`
      );
    }

    return "refreshed";
  }

  if (existing) {
    const { error: updateError } = await supabase
      .from("ai_opportunities")
      .update({
        priority: input.opportunity.priority,
        confidence: input.opportunity.confidence,
        ...truth,
        signal_summary: input.opportunity.signalSummary,
        next_best_action: input.opportunity.nextBestAction,
        reply_handling_goal: input.opportunity.replyHandlingGoal,
        recommended_message: input.opportunity.recommendedMessage,
        source: "mailchimp",
        last_evaluated_at: now,
        updated_at: now,
      })
      .eq("id", existing.id);

    if (updateError) {
      throw new Error(
        `Failed to update Mailchimp opportunity: ${updateError.message}`
      );
    }

    return "updated";
  }

  const { error: insertError } = await supabase.from("ai_opportunities").insert({
    business_id: BUSINESS_ID,
    customer_profile_id: input.customerProfileId,
    targeting_profile_id: null,
    recognized_opportunity: input.opportunity.recognizedOpportunity,
    opportunity_type: input.opportunity.opportunityType,
    playbook: input.opportunity.playbook,
    status: "open",
    priority: input.opportunity.priority,
    confidence: input.opportunity.confidence,
    ...truth,
    signal_summary: input.opportunity.signalSummary,
    next_best_action: input.opportunity.nextBestAction,
    reply_handling_goal: input.opportunity.replyHandlingGoal,
    recommended_message: input.opportunity.recommendedMessage,
    source: "mailchimp",
    opened_at: now,
    last_evaluated_at: now,
    updated_at: now,
  });

  if (insertError) {
    throw new Error(
      `Failed to create Mailchimp opportunity: ${insertError.message}`
    );
  }

  return "created";
}

export async function POST() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();
    const { audienceId } = getMailchimpConfig();

    const count = 100;
    let offset = 0;
    let totalItems = 0;

    let synced = 0;
    let contactsStaged = 0;
    let identityLinksCreatedOrUpdated = 0;
    let customerProfilesEnriched = 0;
    let customerProfilesCreated = 0;
    let skippedNoReachableData = 0;

    let mailchimpOpportunitiesCreated = 0;
    let mailchimpOpportunitiesUpdated = 0;
    let mailchimpOpportunitiesRefreshed = 0;
    let skippedNoIntent = 0;
    let skippedNoLeadStage = 0;
    let skippedDoNotContact = 0;
    let skippedNoPhone = 0;

    while (true) {
      const params = new URLSearchParams({
        count: String(count),
        offset: String(offset),
        fields:
          "members.id,members.email_address,members.status,members.merge_fields,members.tags,total_items",
      });

      const data = await mailchimpFetch<{
        members?: MailchimpMember[];
        total_items?: number;
      }>(`/lists/${audienceId}/members?${params.toString()}`);

      const members = data.members ?? [];
      totalItems = data.total_items ?? totalItems;

      if (members.length === 0) break;

      const contacts = members.map(extractContact);

      const contactRows = contacts.map((contact) => ({
        business_id: BUSINESS_ID,
        mailchimp_member_id: contact.mailchimpMemberId,
        email: contact.email,
        phone: contact.phone,
        first_name: contact.firstName,
        last_name: contact.lastName,
        status: contact.status,
        tags: contact.tags,
        merge_fields: contact.mergeFields,
        raw_payload: contact.rawPayload,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));

      const { error: contactUpsertError } = await supabase
        .from("mailchimp_contacts")
        .upsert(contactRows, {
          onConflict: "business_id,mailchimp_member_id",
        });

      if (contactUpsertError) {
        return NextResponse.json(
          {
            error: "Failed to save Mailchimp contacts",
            details: contactUpsertError.message,
          },
          { status: 500 }
        );
      }

      contactsStaged += contactRows.length;

      for (const contact of contacts) {
        const normalizedTags = contact.tags.map((tag) => tag.toLowerCase());

        if (!contact.email && !contact.phone) {
          skippedNoReachableData += 1;
          continue;
        }

        let match = await findBestCustomerMatch({
          supabase,
          contact,
        });

        if (!match) {
          match = await createOrUpdateCustomerFromMailchimp({
            supabase,
            contact,
          });

          customerProfilesCreated += 1;
        } else {
          const updatePayload = buildCustomerUpdatePayload({
            existingCustomer: match.customer,
            contact,
            confidence: match.confidence,
          });

          const { error: updateError } = await supabase
            .from("customer_profiles")
            .update(updatePayload)
            .eq("id", match.customer.id)
            .eq("business_id", BUSINESS_ID);

          if (updateError) {
            return NextResponse.json(
              {
                error: "Failed to safely enrich customer profile",
                details: updateError.message,
              },
              { status: 500 }
            );
          }

          customerProfilesEnriched += 1;
        }

        const { error: linkError } = await supabase
          .from("customer_identity_links")
          .upsert(
            {
              business_id: BUSINESS_ID,
              customer_profile_id: match.customer.id,
              source: "mailchimp",
              external_id: contact.mailchimpMemberId,
              email: contact.email,
              phone: contact.phone,
              match_method: match.matchMethod,
              confidence: match.confidence,
              verified: match.verified,
              verified_at: match.verified ? new Date().toISOString() : null,
              raw_payload: contact.rawPayload,
              updated_at: new Date().toISOString(),
            },
            {
              onConflict: "business_id,source,external_id",
            }
          );

        if (linkError) {
          return NextResponse.json(
            {
              error: "Failed to save identity link",
              details: linkError.message,
            },
            { status: 500 }
          );
        }

        identityLinksCreatedOrUpdated += 1;

        const hasCleanIntent = hasAnyTag(normalizedTags, [
          "intent:lesson",
          "intent:simulator",
          "intent:membership",
          "intent:event",
          "intent:clinic",
          "intent:junior",
          "intent:reactivation",
          "intent:general",
        ]);

        const hasLeadStage = hasAnyTag(normalizedTags, [
          "stage:new-lead",
          "stage:interested",
          "stage:lapsed",
        ]);

        const isDoNotContact = hasAnyTag(normalizedTags, [
          "do_not:contact",
          "do_not:text",
          "stage:not-interested",
          "stage:converted",
        ]);

        if (!hasCleanIntent) {
          skippedNoIntent += 1;
          continue;
        }

        if (!hasLeadStage) {
          skippedNoLeadStage += 1;
          continue;
        }

        if (isDoNotContact) {
          skippedDoNotContact += 1;
          continue;
        }

        if (!hasUsablePhone(contact.phone)) {
          skippedNoPhone += 1;
          continue;
        }

        const isMember =
          Boolean(match.customer.is_member) ||
          hasTag(normalizedTags, "segment:member");

        const opportunity = buildMailchimpOpportunity({
          contact,
          isMember,
        });

        if (!opportunity) {
          skippedNoIntent += 1;
          continue;
        }

        const result = await upsertMailchimpOpportunity({
          supabase,
          customerProfileId: match.customer.id,
          contact,
          opportunity,
        });

        if (result === "created") {
          mailchimpOpportunitiesCreated += 1;
        } else if (result === "updated") {
          mailchimpOpportunitiesUpdated += 1;
        } else if (result === "refreshed") {
          mailchimpOpportunitiesRefreshed += 1;
        }
      }

      synced += members.length;
      offset += count;

      if (synced >= totalItems) break;
      if (synced >= 3000) break;
    }

    return NextResponse.json({
      success: true,
      totalItems,
      synced,
      contactsStaged,
      identityLinksCreatedOrUpdated,
      customerProfilesEnriched,
      customerProfilesCreated,
      skippedNoReachableData,
      mailchimpOpportunitiesCreated,
      mailchimpOpportunitiesUpdated,
      mailchimpOpportunitiesRefreshed,
      skippedNoIntent,
      skippedNoLeadStage,
      skippedDoNotContact,
      skippedNoPhone,
      mergeMode: "safe_identity_links",
      opportunityMode: "mailchimp_lead_intent",
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Mailchimp contact sync failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}