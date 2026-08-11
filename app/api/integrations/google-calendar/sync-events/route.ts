import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { gateBusinessUser } from "../../../lib/require-auth";
import { evaluateGoogleCalendarBookingOpportunities } from "../../../lib/google-calendar-booking-opportunities";
import {
  coercePublicCustomerEmail,
  loadWhooshNameIndex,
  parseLessonParenTitle,
  resolveLessonBookingIdentity,
  isInternalOrAdminCalendarEmail,
} from "../../../lib/lesson-whoosh-identity";
import { BUSINESS_ID } from "../../../config";
import { findCustomerProfileIdByContact } from "../../../lib/google-calendar-customer-match";
import { syncWithFullSyncTokenRecovery } from "../../../../../lib/google-calendar/full-sync-required";

const PREFERRED_GOOGLE_CALENDAR_EMAIL =
  process.env.CLOSEOS_GOOGLE_CALENDAR_ACCOUNT_EMAIL?.trim().toLowerCase() ??
  "primetimegolfoakland@gmail.com";

type BookingCalendarRow = {
  id: string;
  business_id: string;
  calendar_id: string;
  calendar_name: string;
  calendar_type: string;
  sync_token: string | null;
};

type GoogleCalendarConnection = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
  google_account_email?: string | null;
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

function getOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Google OAuth environment variables");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function normalizePhone(value: string | null | undefined) {
  if (!value) return null;

  const digits = value.replace(/\D/g, "");

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  return null;
}

function extractEmailFromText(text: string) {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0]?.toLowerCase() ?? null;
}

function extractPhoneFromText(text: string) {
  const match = text.match(
    /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/
  );

  return normalizePhone(match?.[0] ?? null);
}

function stripHtml(value: string | null | undefined) {
  if (!value) return "";

  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyReservationType(input: {
  title: string;
  description: string;
  location: string | null;
}) {
  const text = `${input.title} ${input.description} ${
    input.location ?? ""
  }`.toLowerCase();

  if (
    text.includes("private lesson") ||
    text.includes("golf lesson") ||
    text.includes("lesson") ||
    text.includes("instructor") ||
    text.includes("coach") ||
    text.includes("coaching")
  ) {
    return "lesson";
  }

  if (
    text.includes("clinic") ||
    text.includes("camp") ||
    text.includes("junior") ||
    text.includes("youth") ||
    text.includes("ladies learn") ||
    text.includes("women's golf clinic") ||
    text.includes("womens golf clinic")
  ) {
    return "clinic";
  }

  if (
    text.includes("event") ||
    text.includes("party") ||
    text.includes("outing") ||
    text.includes("corporate") ||
    text.includes("birthday") ||
    text.includes("team building") ||
    text.includes("group") ||
    text.includes("celebration") ||
    text.includes("fundraiser") ||
    text.includes("tournament")
  ) {
    return "event";
  }

  return "unknown";
}

function mapGoogleStatus(status: string | null | undefined) {
  if (status === "cancelled") return "cancelled";
  if (status === "confirmed") return "booked";
  if (status === "tentative") return "booked";

  return "unknown";
}

function extractCustomerName(input: {
  title: string;
  description: string;
  attendeeEmails: string[];
}) {
  const text = `${input.title}\n${input.description}`;

  const labeledNameMatch = text.match(
    /(?:customer|client|guest|student|name)\s*[:\-]\s*([A-Za-z ,.'-]{2,80})/i
  );

  if (labeledNameMatch?.[1]) {
    return labeledNameMatch[1].trim();
  }

  const titleParts = input.title
    .split(/[-–—|]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (titleParts.length >= 2) {
    return titleParts[titleParts.length - 1];
  }

  const nonInternalEmail = input.attendeeEmails.find(
    (email) => !isInternalOrAdminCalendarEmail(email)
  );

  if (nonInternalEmail) {
    return nonInternalEmail.split("@")[0].replace(/[._]/g, " ");
  }

  return null;
}

function extractInstructor(input: {
  title: string;
  description: string;
  attendeeEmails: string[];
  attendees:
    | Array<{
        email?: string | null;
        displayName?: string | null;
      }>
    | undefined;
}) {
  const text = `${input.title}\n${input.description}`;

  const labeledInstructorMatch = text.match(
    /(?:instructor|coach|teacher)\s*[:\-]\s*([A-Za-z ,.'-]{2,80})/i
  );

  const instructorEmail =
    input.attendeeEmails.find(
      (email) =>
        email.includes("primetime") ||
        email.includes("instructor") ||
        email.includes("coach")
    ) ?? null;

  const attendeeName =
    input.attendees?.find(
      (attendee) =>
        attendee.email?.toLowerCase() === instructorEmail?.toLowerCase()
    )?.displayName ?? null;

  return {
    instructorName: labeledInstructorMatch?.[1]?.trim() ?? attendeeName,
    instructorEmail,
  };
}

async function safeFillCustomerContactFromCalendar(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  customerProfileId: string;
  calendarEmail: string | null;
  calendarPhone: string | null;
}) {
  const { supabase, customerProfileId, calendarEmail, calendarPhone } = input;

  if (!calendarEmail && !calendarPhone) return;

  const { data: profile, error } = await supabase
    .from("customer_profiles")
    .select("email, phone")
    .eq("id", customerProfileId)
    .eq("business_id", BUSINESS_ID)
    .maybeSingle();

  if (error || !profile) return;

  const updates: Record<string, string> = {};
  const typed = profile as { email: string | null; phone: string | null };

  if (calendarEmail && !typed.email) {
    updates.email = calendarEmail;
  }

  if (calendarPhone && !typed.phone) {
    updates.phone = calendarPhone;
  }

  if (Object.keys(updates).length === 0) return;

  const { error: updateError } = await supabase
    .from("customer_profiles")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", customerProfileId)
    .eq("business_id", BUSINESS_ID);

  if (updateError) {
    throw new Error(updateError.message);
  }
}

type WhooshNameIndex = Awaited<ReturnType<typeof loadWhooshNameIndex>>;

async function syncCalendar(input: {
  supabase: ReturnType<typeof getSupabaseAdmin>;
  calendar: BookingCalendarRow;
  calendarClient: ReturnType<typeof google.calendar>;
  whooshNameIndex: WhooshNameIndex;
}) {
  const { supabase, calendar, calendarClient, whooshNameIndex } = input;

  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;

  let syncedEvents = 0;
  let cancelledEvents = 0;
  let skippedNoTime = 0;
  let matchedCustomers = 0;

  do {
    const response = await calendarClient.events.list({
      calendarId: calendar.calendar_id,
      pageToken,
      singleEvents: true,
      showDeleted: true,
      maxResults: 250,

      // Incremental sync uses syncToken. First full sync uses date range.
      syncToken: calendar.sync_token ?? undefined,
      orderBy: calendar.sync_token ? undefined : "startTime",
      timeMin: calendar.sync_token
        ? undefined
        : new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString(),
      timeMax: calendar.sync_token
        ? undefined
        : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const events = response.data.items ?? [];

    for (const event of events) {
      const title = event.summary ?? "";
      const description = stripHtml(event.description);
      const location = event.location ?? null;

      const startsAt = event.start?.dateTime ?? event.start?.date ?? null;
      const endsAt = event.end?.dateTime ?? event.end?.date ?? null;

      if (!startsAt || !endsAt) {
        skippedNoTime += 1;
        continue;
      }

      const attendeeEmails =
  event.attendees
    ?.map((attendee: { email?: string | null }) =>
      attendee.email?.toLowerCase()
    )
    .filter((email: string | undefined): email is string => Boolean(email)) ??
  [];

      const joinedText = `${title}\n${description}\n${location ?? ""}\n${attendeeEmails.join(
        "\n"
      )}`;

      const { instructorName, instructorEmail } = extractInstructor({
        title,
        description,
        attendeeEmails,
        attendees: event.attendees,
      });

      const lessonParen = parseLessonParenTitle(title);

      let customerEmail: string | null = null;
      let customerPhone: string | null = null;
      let customerName: string | null = null;
      let customerProfileId: string | null = null;

      if (lessonParen.kind !== "none") {
        const resolved = await resolveLessonBookingIdentity({
          supabase,
          businessId: BUSINESS_ID,
          title,
          nameIndex: whooshNameIndex,
        });
        customerName = resolved.customerName;
        customerEmail = resolved.customerEmail;
        customerPhone = resolved.customerPhone;
        customerProfileId = resolved.customerProfileId;
      } else {
        customerEmail =
          coercePublicCustomerEmail(extractEmailFromText(joinedText)) ??
          coercePublicCustomerEmail(
            attendeeEmails.find(
              (email) => !isInternalOrAdminCalendarEmail(email)
            ) ?? null
          ) ??
          null;

        customerPhone = extractPhoneFromText(joinedText);

        customerName = extractCustomerName({
          title,
          description,
          attendeeEmails,
        });

        customerProfileId = await findCustomerProfileIdByContact({
          supabase,
          businessId: BUSINESS_ID,
          email: customerEmail,
          phone: customerPhone,
        });
      }

      if (customerProfileId) {
        matchedCustomers += 1;
        await safeFillCustomerContactFromCalendar({
          supabase,
          customerProfileId,
          calendarEmail: customerEmail,
          calendarPhone: customerPhone,
        });
      }

      const reservationType = classifyReservationType({
        title,
        description,
        location,
      });

      const status = mapGoogleStatus(event.status);

      if (status === "cancelled") {
        cancelledEvents += 1;
      }

      const { error: reservationError } = await supabase
        .from("booking_reservations")
        .upsert(
          {
            business_id: BUSINESS_ID,
            customer_profile_id: customerProfileId,
            calendar_id: calendar.id,
            resource_id: null,

            reservation_type: reservationType,
            status,

            title,
            description,
            location,

            starts_at: startsAt,
            ends_at: endsAt,

            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerPhone,

            instructor_name: instructorName,
            instructor_email: instructorEmail,

            attendee_emails: attendeeEmails,

            source: "google_calendar",
            external_id: event.id,
            html_link: event.htmlLink ?? null,

            raw_payload: event,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "business_id,source,external_id",
          }
        );

      if (reservationError) {
        throw new Error(reservationError.message);
      }

      syncedEvents += 1;
    }

    pageToken = response.data.nextPageToken ?? undefined;
    nextSyncToken = response.data.nextSyncToken ?? nextSyncToken;
  } while (pageToken);

  if (nextSyncToken) {
    const now = new Date().toISOString();
    const wasIncremental = Boolean(calendar.sync_token);

    const { error: updateCalendarError } = await supabase
      .from("booking_calendars")
      .update({
        sync_token: nextSyncToken,
        last_incremental_sync_at: now,
        ...(wasIncremental ? {} : { last_full_sync_at: now }),
        updated_at: now,
      })
      .eq("id", calendar.id);

    if (updateCalendarError) {
      throw new Error(updateCalendarError.message);
    }
  }

  return {
    calendarName: calendar.calendar_name,
    calendarType: calendar.calendar_type,
    syncedEvents,
    cancelledEvents,
    skippedNoTime,
    matchedCustomers,
  };
}

export async function POST() {
  try {
    const denied = await gateBusinessUser();
    if (denied) return denied;

    const supabase = getSupabaseAdmin();

    const { data: connections, error: connectionError } = await supabase
      .from("google_calendar_connections")
      .select(
        "access_token, refresh_token, expiry_date, connected_at, google_account_email"
      )
      .eq("business_id", BUSINESS_ID)
      .is("revoked_at", null)
      .not("refresh_token", "is", null)
      .order("connected_at", { ascending: false });

    const rows = (connections ?? []) as Array<
      GoogleCalendarConnection & {
        connected_at?: string;
        google_account_email?: string | null;
      }
    >;

    const preferred =
      rows.find(
        (r) =>
          (r.google_account_email ?? "").toLowerCase() ===
          PREFERRED_GOOGLE_CALENDAR_EMAIL
      ) ?? rows[0];

    const connection = preferred;

    if (connectionError || !connection?.refresh_token) {
      return NextResponse.json(
        {
          error: "Google Calendar is not connected",
          details:
            connectionError?.message ??
            "Missing Google Calendar refresh token. Reconnect Google Calendar.",
        },
        { status: 400 }
      );
    }

    const oauth2Client = getOAuthClient();

    oauth2Client.setCredentials({
      access_token: connection.access_token ?? undefined,
      refresh_token: connection.refresh_token,
      expiry_date: connection.expiry_date ?? undefined,
    });

    const calendarClient = google.calendar({
      version: "v3",
      auth: oauth2Client,
    });

    const { data: calendars, error: calendarsError } = await supabase
      .from("booking_calendars")
      .select(
        "id, business_id, calendar_id, calendar_name, calendar_type, sync_token"
      )
      .eq("business_id", BUSINESS_ID)
      .eq("provider", "google_calendar")
      .eq("active", true)
      .in("calendar_type", ["booking", "lesson", "event"]);

    if (calendarsError) {
      return NextResponse.json(
        {
          error: "Failed to load booking calendars",
          details: calendarsError.message,
        },
        { status: 500 }
      );
    }

    const results: Array<Record<string, unknown>> = [];

    let whooshNameIndex: WhooshNameIndex = new Map();
    try {
      whooshNameIndex = await loadWhooshNameIndex(supabase, BUSINESS_ID);
    } catch {
      whooshNameIndex = new Map();
    }

    for (const calendar of (calendars ?? []) as BookingCalendarRow[]) {
      try {
        const result = await syncWithFullSyncTokenRecovery({
          calendar,
          sync: (cal) =>
            syncCalendar({
              supabase,
              calendar: cal,
              calendarClient,
              whooshNameIndex,
            }),
          clearSyncToken: async () => {
            const now = new Date().toISOString();
            const { error: clearError } = await supabase
              .from("booking_calendars")
              .update({
                sync_token: null,
                updated_at: now,
              })
              .eq("id", calendar.id);

            if (clearError) {
              throw new Error(clearError.message);
            }
          },
        });

        results.push(result);
      } catch (error) {
        results.push({
          calendarName: calendar.calendar_name,
          calendarType: calendar.calendar_type,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    let bookingOpportunities:
      | Awaited<ReturnType<typeof evaluateGoogleCalendarBookingOpportunities>>
      | { error: string } = { error: "skipped" };

    try {
      bookingOpportunities = await evaluateGoogleCalendarBookingOpportunities({
        supabase,
        businessId: BUSINESS_ID,
      });
    } catch (e) {
      bookingOpportunities = {
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }

    return NextResponse.json({
      success: true,
      mode: "google_calendar_single_booking_calendar_sync",
      calendarsChecked: calendars?.length ?? 0,
      results,
      bookingOpportunities,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Google Calendar sync failed",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}