import Link from "next/link";
import {
  runRevenuePipeline,
  type Lead,
  type FacilityContext,
} from "@/lib/revenue/engine";

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function labelize(value: string) {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function priorityClass(priority: string) {
  if (priority === "high") {
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  }

  if (priority === "medium") {
    return "border-indigo-200 bg-indigo-50 text-indigo-700";
  }

  return "border-slate-200 bg-slate-50 text-slate-600";
}

function typeClass(type: string) {
  if (type === "lesson") {
    return "border-indigo-200 bg-indigo-50 text-indigo-700";
  }

  if (type === "membership") {
    return "border-slate-300 bg-slate-100 text-slate-800";
  }

  if (type === "event") {
    return "border-violet-200 bg-violet-50 text-violet-700";
  }

  return "border-slate-200 bg-white text-slate-600";
}

export default function OpportunitiesPage() {
  const leads: Lead[] = [
    {
      id: "1",
      name: "James Carter",
      phone: "+15105550101",
      email: null,
      lead_type: "lesson",
      has_booking_intent: true,
      has_availability_inquiry: true,
      has_pricing_inquiry: false,
      has_past_lesson: true,
      booking_intent_at: new Date().toISOString(),
      last_outbound_at: null,
      last_contact_at: null,
      last_booked_at: null,
      inquiry_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      is_returning_customer: true,
      event_value: null,
    },
    {
      id: "2",
      name: "Sarah Mitchell",
      phone: "+15105550102",
      email: null,
      lead_type: "event",
      has_booking_intent: false,
      has_availability_inquiry: true,
      has_pricing_inquiry: true,
      has_past_lesson: false,
      booking_intent_at: null,
      last_outbound_at: null,
      last_contact_at: null,
      last_booked_at: null,
      inquiry_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString(),
      is_returning_customer: false,
      event_value: 4500,
    },
  ];

  const context: FacilityContext = {
    empty_slot_times: [new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()],
    unsold_event_ids: ["event-001"],
    lapsed_member_ids: [],
    now: new Date().toISOString(),
  };

  const opportunities = runRevenuePipeline(leads, context);

  const totalRevenue = opportunities.reduce(
    (sum, opportunity) => sum + (opportunity.estimated_revenue || 0),
    0
  );

  const highPriorityCount = opportunities.filter(
    (opportunity) => opportunity.priority === "high"
  ).length;

  const eventCount = opportunities.filter(
    (opportunity) => opportunity.lead_type === "event"
  ).length;

  return (
    <main className="min-h-screen bg-[#f7f8fb] px-6 py-8 text-slate-950">
      <div className="mx-auto max-w-7xl">
        <section className="mb-6 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.06)]">
          <div className="grid lg:grid-cols-[1fr_360px]">
            <div className="p-8 lg:p-10">
              <div className="mb-7 flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-slate-950 text-sm font-semibold text-white">
                  C
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-950">
                    CloseOS
                  </div>
                  <div className="text-xs font-medium text-slate-500">
                    Revenue Command Center
                  </div>
                </div>
              </div>

              <div className="max-w-3xl">
                <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-indigo-600">
                  Opportunities
                </p>
                <h1 className="text-4xl font-semibold tracking-[-0.045em] text-slate-950 md:text-5xl">
                  Prioritized revenue motions ready for execution.
                </h1>
                <p className="mt-5 max-w-2xl text-sm leading-6 text-slate-500">
                  AI-ranked plays to recover warm leads, fill weak calendar
                  windows, and convert high-intent lesson, membership, and event
                  demand.
                </p>
              </div>
            </div>

            <div className="border-t border-slate-200 bg-slate-950 p-8 text-white lg:border-l lg:border-t-0">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
                Pipeline Value
              </div>
              <div className="mt-3 text-5xl font-semibold tracking-[-0.06em] text-white">
                {formatMoney(totalRevenue)}
              </div>
              <p className="mt-4 text-sm leading-6 text-slate-400">
                Estimated value currently surfaced by the revenue engine.
              </p>

              <div className="mt-8 grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="text-xs text-slate-400">High priority</div>
                  <div className="mt-2 text-2xl font-semibold">
                    {highPriorityCount}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <div className="text-xs text-slate-400">Event plays</div>
                  <div className="mt-2 text-2xl font-semibold">{eventCount}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mb-6 grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
              Total Opportunities
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              {opportunities.length}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
              Revenue Target
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-emerald-600">
              {formatMoney(totalRevenue)}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
              Weak Slots
            </div>
            <div className="mt-2 text-3xl font-semibold tracking-[-0.04em]">
              {context.empty_slot_times.length}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-medium uppercase tracking-[0.14em] text-slate-400">
              Execution Mode
            </div>
            <div className="mt-2 text-lg font-semibold tracking-[-0.02em]">
              Review & Launch
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white shadow-[0_18px_70px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-3 border-b border-slate-200 px-6 py-5 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-[-0.03em] text-slate-950">
                Recommended revenue plays
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Ranked by score, revenue type, and urgency window.
              </p>
            </div>

            <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1">
              <span className="rounded-full bg-slate-950 px-3 py-1.5 text-xs font-semibold text-white">
                Today
              </span>
              <span className="px-3 py-1.5 text-xs font-semibold text-slate-500">
                Automated
              </span>
            </div>
          </div>

          <div className="grid gap-0 divide-y divide-slate-100">
            {opportunities.map((opportunity, index) => {
              const opportunityId = `${opportunity.lead_id}-${opportunity.opportunity_type}`;

              const href =
                `/outbound?opportunity_id=${encodeURIComponent(opportunityId)}` +
                `&playbook=${encodeURIComponent(opportunity.lead_type)}` +
                `&contacts=1` +
                `&estimated_revenue=${encodeURIComponent(
                  String(opportunity.estimated_revenue)
                )}` +
                `&lead_name=${encodeURIComponent(opportunity.lead_name)}` +
                `&lead_type=${encodeURIComponent(opportunity.lead_type)}` +
                `&opportunity_type=${encodeURIComponent(
                  opportunity.opportunity_type
                )}`;

              return (
                <article
                  key={opportunityId}
                  className="grid gap-5 p-6 transition hover:bg-slate-50/70 lg:grid-cols-[52px_1fr_240px]"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-200 bg-white text-sm font-semibold text-slate-500 shadow-sm">
                    {String(index + 1).padStart(2, "0")}
                  </div>

                  <div className="min-w-0">
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${typeClass(
                          opportunity.lead_type
                        )}`}
                      >
                        {labelize(opportunity.lead_type)}
                      </span>

                      <span
                        className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${priorityClass(
                          opportunity.priority
                        )}`}
                      >
                        {labelize(opportunity.priority)} Priority
                      </span>

                      <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-500">
                        {labelize(opportunity.opportunity_type)}
                      </span>
                    </div>

                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <h3 className="text-xl font-semibold tracking-[-0.035em] text-slate-950">
                          {opportunity.lead_name}
                        </h3>
                        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                          {opportunity.recommended_action}
                        </p>
                      </div>

                      <div className="shrink-0 md:text-right">
                        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                          Est. Revenue
                        </div>
                        <div className="mt-1 text-2xl font-semibold tracking-[-0.04em] text-emerald-600">
                          {formatMoney(opportunity.estimated_revenue)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                        Message Preview
                      </div>
                      <p className="line-clamp-2 text-sm leading-6 text-slate-600">
                        {opportunity.suggested_message}
                      </p>
                    </div>

                    {!!opportunity.opportunity_tags?.length && (
                      <div className="mt-4 flex flex-wrap gap-2">
                        {opportunity.opportunity_tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500"
                          >
                            {labelize(tag)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col justify-between rounded-3xl border border-slate-200 bg-slate-950 p-5 text-white shadow-sm">
                    <div>
                      <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
                        Action
                      </div>
                      <p className="mt-3 text-base font-semibold leading-6 tracking-[-0.025em]">
                        Open campaign workspace and prepare outbound motion.
                      </p>
                    </div>

                    <Link
                      href={href}
                      className="mt-6 inline-flex items-center justify-center rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-indigo-50"
                    >
                      Open Campaign
                    </Link>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}