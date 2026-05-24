/**
 * Whoosh integration booking_request payload + HTTP response classification.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import type { NormalizedWhooshAvailabilitySlot } from "@/lib/whoosh/availability";
import {
  WHOOSH_BOOKING_GUEST_MEMBER_CONFIG_ERROR,
  buildWhooshBookingAttemptedPostPayloadSummary,
  buildWhooshIntegrationBookingWire,
  classifyWhooshBookingHttpResponse,
  createWhooshBooking,
  emptyWhooshRawAgendaKeyPresence,
  normalizeWhooshBookingTransportation,
  resolveWhooshBookingAgendaCorrelationId,
  resolveWhooshBookingHolesTransportationDefaults,
  resolveWhooshBookingMemberNumber,
  summarizeWhooshBookingPostPayloadForAudit,
  whooshIntegrationRequestPersistSummary,
  whooshIntegrationWireToPostJson,
  whooshSlotRawAgendaKeyPresence,
  type WhooshBookingCreateParams,
  type WhooshIntegrationBookingWire,
} from "@/lib/whoosh/bookings";

describe("normalizeWhooshBookingTransportation", () => {
  test("unset/blank resolves to cart", () => {
    assert.strictEqual(normalizeWhooshBookingTransportation(undefined), "cart");
    assert.strictEqual(normalizeWhooshBookingTransportation(""), "cart");
    assert.strictEqual(normalizeWhooshBookingTransportation("  "), "cart");
  });

  test("none/walk synonyms map to cart (case-insensitive)", () => {
    assert.strictEqual(normalizeWhooshBookingTransportation("none"), "cart");
    assert.strictEqual(normalizeWhooshBookingTransportation("NONE"), "cart");
    assert.strictEqual(normalizeWhooshBookingTransportation("walk"), "cart");
  });

  test("riding/ride synonyms map to cart", () => {
    assert.strictEqual(normalizeWhooshBookingTransportation("cart"), "cart");
    assert.strictEqual(normalizeWhooshBookingTransportation("riding"), "cart");
    assert.strictEqual(normalizeWhooshBookingTransportation("ride"), "cart");
  });

  test("unknown tokens pass through with casing unchanged", () => {
    assert.strictEqual(normalizeWhooshBookingTransportation("walking"), "walking");
    assert.strictEqual(normalizeWhooshBookingTransportation("Walking"), "Walking");
    assert.strictEqual(normalizeWhooshBookingTransportation("WHOOSH_OTHER"), "WHOOSH_OTHER");
  });
});

describe("summarizeWhooshBookingPostPayloadForAudit", () => {
  test("pulls audited fields from merged POST-shaped body", () => {
    assert.deepStrictEqual(
      summarizeWhooshBookingPostPayloadForAudit({
        transportation: "cart",
        holes: "18",
        memberNumber: "  g  ",
        dateTime: "2026-05-01T10:00:00.000Z",
        totalPlayerCount: 2,
      }),
      {
        transportation: "cart",
        holes: "18",
        memberNumberPresent: true,
        dateTime: "2026-05-01T10:00:00.000Z",
        totalPlayerCount: 2,
      },
    );
  });

  test("memberNumberPresent false when missing or blank", () => {
    assert.strictEqual(
      summarizeWhooshBookingPostPayloadForAudit({
        holes: "9",
        transportation: null,
      }).memberNumberPresent,
      false,
    );
  });
});

describe("resolveWhooshBookingAgendaCorrelationId / whooshSlotRawAgendaKeyPresence", () => {
  test("prefers snake_case agenda_id over camel agendaId when both exist", () => {
    assert.strictEqual(
      resolveWhooshBookingAgendaCorrelationId({
        agendaId: "from-camel",
        agenda_id: "from-snake",
      }),
      "from-snake",
    );
  });

  test("maps agendaId camel key onto agenda_id POST value via wire builder", () => {
    const slot: NormalizedWhooshAvailabilitySlot = {
      ...slotFixture(),
      raw: {
        ...(slotFixture().raw as Record<string, unknown>),
        agendaId: "vendor-agenda-camel",
      },
    };
    const base: WhooshBookingCreateParams = {
      ...guestParams(),
      selectedSlot: slot,
      contactMemberNumber: "fixture-contact-m",
    };
    const mr = resolveWhooshBookingMemberNumber(base);
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;

    const wire = buildWhooshIntegrationBookingWire(base, mr);
    assert.strictEqual(wire.agenda_id, "vendor-agenda-camel");
    assert.strictEqual(wire.integrationSlotRawAgendaKeyPresence?.agendaId, true);

    const post = whooshIntegrationWireToPostJson(wire);
    assert.strictEqual(post.agenda_id, "vendor-agenda-camel");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(post, "agendaId"), false);

    assert.deepStrictEqual(whooshSlotRawAgendaKeyPresence(slot.raw as Record<string, unknown>), {
      agenda_id: false,
      agendaId: true,
      agenda_uuid: false,
      agendaUuid: false,
      schedule_id: false,
      scheduleId: false,
      booking_window_id: false,
      bookingWindowId: false,
    });
  });

  test("raw agenda_id passes through to POST payload as agenda_id", () => {
    const slot: NormalizedWhooshAvailabilitySlot = {
      ...slotFixture(),
      raw: {
        ...(slotFixture().raw as Record<string, unknown>),
        agenda_id: "vendor-ag-snake",
      },
    };
    const base: WhooshBookingCreateParams = {
      ...guestParams(),
      selectedSlot: slot,
      contactMemberNumber: "fixture-contact-m",
    };
    const mr = resolveWhooshBookingMemberNumber(base);
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;
    const wire = buildWhooshIntegrationBookingWire(base, mr);
    const post = whooshIntegrationWireToPostJson(wire);
    assert.strictEqual(post.agenda_id, "vendor-ag-snake");
  });
});

describe("buildWhooshBookingAttemptedPostPayloadSummary", () => {
  test("merges POST core audit with wire identifiers and raw slot fragments", () => {
    const wire: WhooshIntegrationBookingWire = {
      facility_slug: "simulators",
      agenda_date: "2026-05-17",
      slot_id: "s1",
      bay_id: "b1",
      customer: { name: "P", phone: "+1" },
      players: 1,
      start_time: "2026-05-17T11:00:00",
      duration: 60,
      memberNumber: "m",
      dateTime: "2026-05-17T11:00:00",
      totalPlayerCount: 1,
      holes: "18",
      transportation: "cart",
      source: "closeos_sms_agent",
      status: "confirmed",
      course_id: "fc-1",
      integrationDatetimeMode: "raw_local",
      integrationRawSlotDate: "2026-05-17",
      integrationRawSlotTime: "11:00",
    };
    const merged = {
      ...wire,
      customer: { name: "P", phone: "+1" },
    } as Record<string, unknown>;
    assert.deepStrictEqual(
      buildWhooshBookingAttemptedPostPayloadSummary(merged, wire),
      {
        transportation: "cart",
        holes: "18",
        memberNumberPresent: true,
        dateTime: "2026-05-17T11:00:00",
        totalPlayerCount: 1,
        agenda_date: "2026-05-17",
        facility_slug: "simulators",
        course_id: "fc-1",
        slot_id: "s1",
        bay_id: "b1",
        raw_date: "2026-05-17",
        raw_time: "11:00",
        whoosh_booking_datetime_mode: "raw_local",
        agenda_id_present: false,
        whoosh_raw_agenda_key_presence: emptyWhooshRawAgendaKeyPresence(),
      },
    );
  });

  test("failed summary agenda_id_present and raw key presence come from POST + slot raw probe", () => {
    const presenceAllFalse = emptyWhooshRawAgendaKeyPresence();
    presenceAllFalse.agenda_uuid = true;
    const wire: WhooshIntegrationBookingWire = {
      facility_slug: "simulators",
      agenda_date: "2026-05-17",
      slot_id: "s1",
      agenda_id: "ag-supplied",
      bay_id: "b1",
      customer: { name: "P", phone: "+" },
      players: 1,
      start_time: "2026-05-17T11:00:00",
      duration: 60,
      memberNumber: "m",
      dateTime: "2026-05-17T11:00:00",
      totalPlayerCount: 1,
      holes: "18",
      transportation: "cart",
      source: "closeos_sms_agent",
      status: "confirmed",
      integrationSlotRawAgendaKeyPresence: presenceAllFalse,
    };
    const merged = {
      ...whooshIntegrationWireToPostJson(wire),
      customer: { name: "P", phone: "+" },
    };
    assert.deepStrictEqual(buildWhooshBookingAttemptedPostPayloadSummary(merged, wire), {
      transportation: "cart",
      holes: "18",
      memberNumberPresent: true,
      dateTime: "2026-05-17T11:00:00",
      totalPlayerCount: 1,
      agenda_date: "2026-05-17",
      facility_slug: "simulators",
      course_id: null,
      slot_id: "s1",
      bay_id: "b1",
      raw_date: null,
      raw_time: null,
      whoosh_booking_datetime_mode: null,
      agenda_id_present: true,
      whoosh_raw_agenda_key_presence: presenceAllFalse,
    });
  });
});

function slotFixture(): NormalizedWhooshAvailabilitySlot {
  return {
    startTime: "2026-05-17T11:30:00.000-07:00",
    endTime: "2026-05-17T12:30:00.000-07:00",
    bayOrResourceId: "473d2db9-f503-4dec-9afe-cdf8b029db8f",
    resourceName: "Simulator 1",
    serviceType: "simulator",
    priceEstimate: null,
    raw: {
      facility_slug: "simulators",
      agenda_date: "2026-05-17",
      id: "473d2db9-f503-4dec-9afe-cdf8b029db8f",
      course_id: "fc56dd17-ad78-4861-983b-bf7ec7d3233c",
    },
  };
}

function guestParams(): WhooshBookingCreateParams {
  return {
    contactId: "c-9",
    customerName: "Pat",
    customerPhone: "+15551231234",
    selectedSlot: slotFixture(),
    partySize: 2,
    durationMinutes: 60,
  };
}

describe("whoosh bookings integration", () => {
  const savedGuestMn = process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
  const savedHoles = process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
  const savedTransport = process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
  const savedDateTimeMode = process.env.WHOOSH_BOOKING_DATETIME_MODE;

  beforeEach(() => {
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER =
      typeof savedGuestMn === "string" && savedGuestMn.trim() ? savedGuestMn : "bookings-test-guest";
    if (savedHoles !== undefined) process.env.WHOOSH_BOOKING_DEFAULT_HOLES = savedHoles;
    else delete process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
    if (savedTransport !== undefined)
      process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = savedTransport;
    else delete process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
    if (savedDateTimeMode !== undefined)
      process.env.WHOOSH_BOOKING_DATETIME_MODE = savedDateTimeMode;
    else delete process.env.WHOOSH_BOOKING_DATETIME_MODE;
  });

  afterEach(() => {
    if (savedGuestMn === undefined) delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
    else process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = savedGuestMn;
    if (savedHoles === undefined) delete process.env.WHOOSH_BOOKING_DEFAULT_HOLES;
    else process.env.WHOOSH_BOOKING_DEFAULT_HOLES = savedHoles;
    if (savedTransport === undefined) delete process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
    else process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = savedTransport;
    if (savedDateTimeMode === undefined) delete process.env.WHOOSH_BOOKING_DATETIME_MODE;
    else process.env.WHOOSH_BOOKING_DATETIME_MODE = savedDateTimeMode;
  });

  test("WHOOSH_BOOKING_DATETIME_MODE=raw_local prefers raw.date + raw.time (no offset)", () => {
    process.env.WHOOSH_BOOKING_DATETIME_MODE = "raw_local";
    const slotRaw = slotFixture().raw as Record<string, unknown>;
    const slotWithRawTime: NormalizedWhooshAvailabilitySlot = {
      ...slotFixture(),
      raw: {
        ...slotRaw,
        date: "2026-05-17",
        time: "11:00",
      },
    };
    const base: WhooshBookingCreateParams = { ...guestParams(), selectedSlot: slotWithRawTime };
    const mr = resolveWhooshBookingMemberNumber(base);
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;
    const wire = buildWhooshIntegrationBookingWire(base, mr);
    assert.strictEqual(wire.dateTime, "2026-05-17T11:00:00");
    assert.strictEqual(wire.start_time, "2026-05-17T11:00:00");
    assert.strictEqual(wire.integrationDatetimeMode, "raw_local");
  });

  test("WHOOSH_BOOKING_DATETIME_MODE=iso_offset uses normalized slot.startTime", () => {
    process.env.WHOOSH_BOOKING_DATETIME_MODE = "iso_offset";
    const slotRaw = slotFixture().raw as Record<string, unknown>;
    const slotWithRawTime: NormalizedWhooshAvailabilitySlot = {
      ...slotFixture(),
      raw: {
        ...slotRaw,
        date: "2026-05-17",
        time: "11:00",
      },
    };
    const base: WhooshBookingCreateParams = { ...guestParams(), selectedSlot: slotWithRawTime };
    const mr = resolveWhooshBookingMemberNumber(base);
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;
    const wire = buildWhooshIntegrationBookingWire(base, mr);
    assert.strictEqual(wire.dateTime, slotWithRawTime.startTime);
    assert.strictEqual(wire.start_time, slotWithRawTime.startTime);
    assert.strictEqual(wire.integrationDatetimeMode, "iso_offset");
  });

  test("buildWhooshIntegrationBookingWire maps slot + customer + Whoosh-required fields", () => {
    const base = guestParams();
    const mr = resolveWhooshBookingMemberNumber(base);
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;

    const wire = buildWhooshIntegrationBookingWire(base, mr);
    assert.strictEqual(wire.facility_slug, "simulators");
    assert.strictEqual(wire.agenda_date, "2026-05-17");
    assert.strictEqual(wire.slot_id, "473d2db9-f503-4dec-9afe-cdf8b029db8f");
    assert.strictEqual(wire.course_id, "fc56dd17-ad78-4861-983b-bf7ec7d3233c");
    assert.strictEqual(wire.bay_id, "473d2db9-f503-4dec-9afe-cdf8b029db8f");
    assert.strictEqual(wire.players, 2);
    assert.strictEqual(wire.start_time, "2026-05-17T11:30:00.000-07:00");
    assert.strictEqual(wire.dateTime, wire.start_time);
    assert.strictEqual(wire.totalPlayerCount, 2);
    assert.strictEqual(wire.duration, 60);
    assert.strictEqual(wire.source, "closeos_sms_agent");
    assert.strictEqual(wire.status, "confirmed");
    assert.strictEqual(wire.customer.name, "Pat");
    assert.strictEqual(wire.customer.phone, "+15551231234");
    assert.ok(typeof wire.memberNumber === "string" && wire.memberNumber.length > 0);
    assert.strictEqual(wire.holes, "18");
    assert.strictEqual(wire.transportation, "cart");
  });

  test("WHOOSH_BOOKING_DEFAULT_TRANSPORTATION unset resolves defaults to cart", () => {
    delete process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION;
    assert.strictEqual(resolveWhooshBookingHolesTransportationDefaults().transportation, "cart");
    const mr = resolveWhooshBookingMemberNumber(guestParams());
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;
    const wire = buildWhooshIntegrationBookingWire(guestParams(), mr);
    assert.strictEqual(wire.transportation, "cart");
  });

  test("WHOOSH_BOOKING_DEFAULT_TRANSPORTATION=none normalizes to cart on wire", () => {
    process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = "none";
    const mr = resolveWhooshBookingMemberNumber(guestParams());
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;
    const wire = buildWhooshIntegrationBookingWire(guestParams(), mr);
    assert.strictEqual(wire.transportation, "cart");
  });

  test("WHOOSH_BOOKING_DEFAULT_TRANSPORTATION=walk yields cart", () => {
    process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = "walk";
    const mr = resolveWhooshBookingMemberNumber(guestParams());
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;
    const wire = buildWhooshIntegrationBookingWire(guestParams(), mr);
    assert.strictEqual(wire.transportation, "cart");
  });

  test("resolveWhooshBookingMemberNumber prefers contactMemberNumber over env", () => {
    process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER = "env-guest";
    const r = resolveWhooshBookingMemberNumber({
      ...guestParams(),
      contactMemberNumber: "  member-99  ",
    });
    assert.deepStrictEqual(r, {
      ok: true,
      memberNumber: "member-99",
      memberNumberPresent: true,
    });
  });

  test("WHOOSH_BOOKING_DEFAULT_HOLES and TRANSPORTATION env defaults", () => {
    process.env.WHOOSH_BOOKING_DEFAULT_HOLES = "9";
    process.env.WHOOSH_BOOKING_DEFAULT_TRANSPORTATION = "cart";
    const base = guestParams();
    const mr = resolveWhooshBookingMemberNumber(base);
    assert.strictEqual(mr.ok, true);
    if (!mr.ok) return;

    const wire = buildWhooshIntegrationBookingWire(base, mr);
    assert.strictEqual(wire.holes, "9");
    assert.strictEqual(wire.transportation, "cart");
    const d = resolveWhooshBookingHolesTransportationDefaults();
    assert.strictEqual(d.holes, "9");
    assert.strictEqual(d.transportation, "cart");

    const persist = whooshIntegrationRequestPersistSummary(wire);
    assert.strictEqual(persist.memberNumberPresent, true);
    assert.strictEqual(persist.memberNumberFromContact, false);
    assert.strictEqual(persist.dateTime, wire.dateTime);
    assert.strictEqual(persist.totalPlayerCount, wire.totalPlayerCount);
    assert.strictEqual(persist.holes, "9");
    assert.strictEqual(persist.transportation, "cart");
    assert.ok(Object.prototype.hasOwnProperty.call(persist, "memberNumberFromContact"));
  });

  test("missing contact member and WHOOSH_BOOKING_GUEST_MEMBER_NUMBER yields config error", () => {
    delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
    const r = resolveWhooshBookingMemberNumber({
      ...guestParams(),
      contactMemberNumber: null,
    });
    assert.deepStrictEqual(r, {
      ok: false,
      error: WHOOSH_BOOKING_GUEST_MEMBER_CONFIG_ERROR,
    });
  });

  test("createWhooshBooking fails before POST when member cannot be resolved", async () => {
    const savedEnabled = process.env.WHOOSH_BOOKING_API_ENABLED;
    const savedPath = process.env.WHOOSH_BOOKING_POST_PATH;
    try {
      delete process.env.WHOOSH_BOOKING_GUEST_MEMBER_NUMBER;
      process.env.WHOOSH_BOOKING_API_ENABLED = "true";
      process.env.WHOOSH_BOOKING_POST_PATH = "/integration/api/booking_request";

      const r = await createWhooshBooking({
        ...guestParams(),
        contactMemberNumber: null,
      });
      assert.strictEqual(r.ok, false);
      if (!r.ok) assert.strictEqual(r.error, WHOOSH_BOOKING_GUEST_MEMBER_CONFIG_ERROR);
    } finally {
      process.env.WHOOSH_BOOKING_API_ENABLED = savedEnabled;
      process.env.WHOOSH_BOOKING_POST_PATH = savedPath;
    }
  });

  test("classified confirmed response sets confirmed outcome with booking id", () => {
    const v = classifyWhooshBookingHttpResponse({
      httpOk: true,
      httpStatus: 200,
      json: { booking_id: "bk-1", status: "confirmed" },
      textBody: "{}",
    });
    assert.strictEqual(v.kind, "success");
    if (v.kind === "success") {
      assert.strictEqual(v.outcome, "confirmed");
      assert.strictEqual(v.bookingId, "bk-1");
      assert.strictEqual(v.requestId, null);
    }
  });

  test("classified pending responses do not surface as confirmed bookings", () => {
    const pending = classifyWhooshBookingHttpResponse({
      httpOk: true,
      httpStatus: 200,
      json: { request_id: "req-42", status: "pending" },
      textBody: "{}",
    });
    assert.strictEqual(pending.kind, "success");
    if (pending.kind === "success") {
      assert.strictEqual(pending.outcome, "pending");
      assert.strictEqual(pending.requestId, "req-42");
      assert.strictEqual(pending.bookingId, null);
    }
  });

  test("HTTP 422 structured errors surfaces field + detail", () => {
    const f = classifyWhooshBookingHttpResponse({
      httpOk: false,
      httpStatus: 422,
      json: {
        data: null,
        errors: [
          {
            title: "Invalid agenda date",
            field: "/dateTime",
            detail: "There is currently no agenda for 2026-05-17",
          },
        ],
      },
      textBody: "{}",
    });
    assert.strictEqual(f.kind, "failure");
    if (f.kind === "failure") {
      assert.match(f.error, /\/dateTime/);
      assert.match(f.error, /no agenda for 2026-05-17/);
    }
  });

  test("HTTP error is a hard failure", () => {
    const f = classifyWhooshBookingHttpResponse({
      httpOk: false,
      httpStatus: 400,
      json: { message: "invalid_payload" },
      textBody: "{}",
    });
    assert.strictEqual(f.kind, "failure");
  });

  test("bare top-level id is treated as queued request id until confirmed language appears", () => {
    const v = classifyWhooshBookingHttpResponse({
      httpOk: true,
      httpStatus: 201,
      json: { id: "correlation-88" },
      textBody: "{}",
    });
    assert.strictEqual(v.kind, "success");
    if (v.kind === "success") {
      assert.strictEqual(v.outcome, "pending");
      assert.strictEqual(v.requestId, "correlation-88");
    }
  });
});
