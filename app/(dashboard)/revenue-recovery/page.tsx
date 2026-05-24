export default function RevenueRecoveryPage() {
  return (
    <div className="space-y-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
          Revenue recovery
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Warm inactive &amp; cancelled recovery
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
          Review reachable customers who haven&apos;t visited recently or cancelled a booking.
          Draft and approve SMS before anything sends.
        </p>
      </section>

      <section className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <p className="text-sm text-slate-600">
          Full recovery workspace loads after Square customer directory sync. Counts on the{" "}
          <a href="/dashboard" className="font-semibold text-emerald-800 hover:underline">
            dashboard
          </a>{" "}
          reflect recovery opportunities from your pipeline.
        </p>
      </section>
    </div>
  );
}
