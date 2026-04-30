import {
  runRevenuePipeline,
  type Lead,
  type FacilityContext,
} from "@/lib/revenue/engine";

export default function TestPage() {
  const leads: Lead[] = [
    {
      id: "1",
      name: "Test Lead",
      phone: "123",
      email: null,
      lead_type: "lesson",
      has_booking_intent: true,
      has_availability_inquiry: false,
      has_pricing_inquiry: false,
      has_past_lesson: false,
      booking_intent_at: new Date().toISOString(),
      last_outbound_at: null,
      last_contact_at: null,
      last_booked_at: null,
      inquiry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  ];

  const context: FacilityContext = {
    empty_slot_times: [],
    unsold_event_ids: [],
    lapsed_member_ids: [],
    now: new Date().toISOString(),
  };

  const result = runRevenuePipeline(leads, context);

  console.log("RESULT:", result);

  return (
    <div style={{ padding: 20 }}>
      <h1>Revenue Engine Test</h1>
      <p>Open console to see results</p>
      <pre>{JSON.stringify(result, null, 2)}</pre>
    </div>
  );
}