import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { BUSINESS_ID } from "../../../config";
import { truthFieldsForDb } from "../../../lib/closeos-opportunity-truth";
import { gateBusinessUser } from "../../../lib/require-auth";

type MailchimpContactRow = {
  id: string;
  mailchimp_member_id: string;
  email: string | null;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  tags: string[];
  status: string | null;
  raw_payload: Record<string, unknown>;
};

type LeadOpportunity = {
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

function normalizePhone(phone: string | null) {
  if (!phone) return null;

  const digitsOnly = phone.replace(/\D/g, "");

  if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`;
  }

  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    return `+${digitsOnly}`;
  }

  return null;
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
    .replace(/\s+/g, " ")
    .trim();
}

function getLeadName(contact: MailchimpContactRow) {
  const fullName = [contact.first_name, contact.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || contact.email || contact.phone || "there";
}

function buildLeadOpportunity(contact: MailchimpContactRow) {
  const tags = contact.tags.map((tag) => tag.toLowerCase());
  const leadName = getLeadName(contact);

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

  if (
    !hasAnyTag(tags, ["stage:new-lead", "stage:interested", "stage:lapsed"])
  ) {
    return null;
  }

  if (hasTag(tags, "intent:lesson")) {
    return {
      recognizedOpportunity: "mailchimp_lesson_interest",
      opportunityType: "lesson",
      playbook: "lesson-lead-follow-up",
      priority: 82,
      confidence: 78,
      estimatedRevenueCents: 15000,
      signalSummary:
        "Mailchimp contact has lesson-interest tags and a reachable phone number.",
      nextBestAction:
        "Follow up about lesson goals and offer specific lesson availability.",
      replyHandlingGoal:
        "If they reply, ask what part of their game they want to improve and route them to lesson booking.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in golf lessons at Primetime Golf. What part of your game are you looking to work on right now?`
      ),
    } satisfies LeadOpportunity;
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
    } satisfies LeadOpportunity;
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
    } satisfies LeadOpportunity;
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
    } satisfies LeadOpportunity;
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
    } satisfies LeadOpportunity;
  }

  if (
    hasTag(tags, "intent:membership") &&
    !hasTag(tags, "segment:member")
  ) {
    return {
      recognizedOpportunity: "mailchimp_membership_interest",
      opportunityType: "membership",
      playbook: "membership-lead-follow-up",
      priority: 79,
      confidence: 74,
      estimatedRevenueCents: 22000,
      signalSummary:
        "Mailchimp contact has membership-interest tags and is not marked as an existing member.",
      nextBestAction:
        "Follow up about membership fit and expected usage.",
      replyHandlingGoal:
        "If they reply, ask how often they plan to use Primetime Golf and route to membership options.",
      recommendedMessage: cleanMessage(
        `Hi ${leadName}, saw you were interested in membership at Primetime Golf. How often do you think you’d use the facility each month?`
      ),
    } satisfies LeadOpportunity;
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
    } satisfies LeadOpportunity;
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
    } satisfies LeadOpportunity;
  }

  return null;
}

async function upsertOpportunity(input: {
  supabase: any;
  customerProfileId: string;
  opportunity: LeadOpportunity;
}) {
  const now = new Date().toISOString();
  const truth = truthFieldsForDb(input.opportunity.recognizedOpportunity);

  const { data: existingRows, error: existingError } = await input.supabase
    .from("ai_opportunities")
    .select("id, status")
    .eq("business_id", BUSINESS_ID)
    .eq("customer_profile_id", input.customerProfileId)
    .eq("recognized_opportunity", input.opportunity.recognizedOpportunity)
    .eq("playbook", input.opportunity.playbook)
    .in("status", ["open", "queued", "launched", "replied"])
    .limit(1);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const existing = existingRows?.[0] as
    | { id: string; status: string }
    | undefined;

  if (existing?.status === "launched" || existing?.status === "replied") {
    // Once a Mailchimp opportunity has been launched or replied to, freeze the
    // sent copy: only refresh metadata, never overwrite recommended_message or
    // sent-copy fields.
    const { error: refreshError } = await input.supabase
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
      throw new Error(refreshError.message);
    }

    return "refreshed";
  }

  if (existing) {
    const { error: updateError } = await input.supabase
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
      throw new Error(updateError.message);
    }

    return "updated";
  }

  const { error: insertError } = await input.supabase
    .from("ai_opportunities")
    .insert({
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
    throw new Error(insertError.message);
  }

  return "created";
}

export async function POST() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin() as any;

    const PAGE_SIZE = 500;
    const MAX_CONTACTS = 5000;
    const contacts: MailchimpContactRow[] = [];
    let lastId: string | null = null;

    while (contacts.length < MAX_CONTACTS) {
      let query = supabase
        .from("mailchimp_contacts")
        .select(
          "id, mailchimp_member_id, email, phone, first_name, last_name, tags, status, raw_payload"
        )
        .eq("business_id", BUSINESS_ID)
        .order("id", { ascending: true })
        .limit(PAGE_SIZE);

      if (lastId) {
        query = query.gt("id", lastId);
      }

      const { data: pageRows, error: pageError } = await query;

      if (pageError) {
        return NextResponse.json(
          {
            error: "Failed to load Mailchimp contacts",
            details: pageError.message,
          },
          { status: 500 }
        );
      }

      const rows = (pageRows ?? []) as MailchimpContactRow[];
      if (rows.length === 0) break;

      contacts.push(...rows);
      lastId = rows[rows.length - 1].id;
      if (rows.length < PAGE_SIZE) break;
    }

    let checked = 0;
    let skippedNoPhone = 0;
    let skippedNoOpportunity = 0;
    let profilesCreatedOrUpdated = 0;
    let opportunitiesCreated = 0;
    let opportunitiesUpdated = 0;
    let opportunitiesRefreshed = 0;

    for (const contact of contacts) {
      checked += 1;

      const normalizedPhone = normalizePhone(contact.phone);

      if (!normalizedPhone) {
        skippedNoPhone += 1;
        continue;
      }

      const opportunity = buildLeadOpportunity({
        ...contact,
        phone: normalizedPhone,
      });

      if (!opportunity) {
        skippedNoOpportunity += 1;
        continue;
      }

      const { data: profile, error: profileError } = await supabase
        .from("customer_profiles")
        .upsert(
          {
            business_id: BUSINESS_ID,
            source: "mailchimp",
            external_customer_id: `mailchimp:${contact.mailchimp_member_id}`,
            first_name: contact.first_name,
            last_name: contact.last_name,
            email: contact.email,
            phone: normalizedPhone,
            ai_segment: "mailchimp_lead",
            ai_score: opportunity.priority,
            identity_confidence: 80,
            identity_sources: ["mailchimp"],
            last_identity_enriched_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "source,external_customer_id",
          }
        )
        .select("id")
        .single();

      if (profileError) {
        return NextResponse.json(
          {
            error: "Failed to create Mailchimp lead profile",
            details: profileError.message,
          },
          { status: 500 }
        );
      }

      profilesCreatedOrUpdated += 1;

      const result = await upsertOpportunity({
        supabase,
        customerProfileId: profile.id,
        opportunity,
      });

      if (result === "created") {
        opportunitiesCreated += 1;
      }

      if (result === "updated") {
        opportunitiesUpdated += 1;
      }

      if (result === "refreshed") {
        opportunitiesRefreshed += 1;
      }
    }

    return NextResponse.json({
      success: true,
      mode: "mailchimp_contacts_to_opportunities",
      checked,
      skippedNoPhone,
      skippedNoOpportunity,
      profilesCreatedOrUpdated,
      opportunitiesCreated,
      opportunitiesUpdated,
      opportunitiesRefreshed,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to create Mailchimp opportunities",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}