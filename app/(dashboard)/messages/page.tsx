export default function MessagesPage() {
  return (
    <div className="space-y-6">
      <section className="motion-card rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
          Conversations
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
          Customer message command center
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
          Track inbound replies, reviewed outbound touches, delivery status, and follow-up readiness from one operator-controlled workspace.
        </p>
      </section>

      <section className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-sm font-bold text-emerald-700">
          CM
        </div>
        <h2 className="mt-4 text-lg font-semibold text-slate-950">No conversation activity yet</h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-600">
          Conversations will appear here after inbound replies or reviewed outbound messages are recorded. Nothing sends without operator approval.
        </p>
      </section>
    </div>
  );
}
