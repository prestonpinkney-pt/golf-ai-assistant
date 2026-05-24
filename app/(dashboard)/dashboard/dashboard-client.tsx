"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type MvpStats = {
  generatedAt: string;
  opportunityCount: number;
  inboxAttentionCount: number;
  recoveryQueueCount: number;
};

const NO_STORE: RequestInit = {
  cache: "no-store",
  credentials: "include",
  headers: { "Cache-Control": "no-cache" },
};

function bust(path: string) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}_=${Date.now()}`;
}

type StatCardProps = {
  eyebrow: string;
  count: number | null;
  label: string;
  href: string;
  cta: string;
  emptyHint: string;
};

function StatCard({ eyebrow, count, label, href, cta, emptyHint }: StatCardProps) {
  const loading = count === null;
  const isEmpty = !loading && count === 0;

  return (
    <Link
      href={href}
      className="group rounded-2xl border border-slate-200/90 bg-white p-6 shadow-sm transition hover:border-emerald-200 hover:shadow-md"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-800">{eyebrow}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-slate-900">
        {loading ? "—" : count}
      </p>
      <p className="mt-1 text-sm font-medium text-slate-800">{label}</p>
      <p className="mt-2 text-xs text-slate-500">{isEmpty ? emptyHint : cta}</p>
      <p className="mt-3 text-sm font-semibold text-emerald-800 group-hover:underline">{cta} →</p>
    </Link>
  );
}

export default function CloseOsDashboardClient() {
  const [stats, setStats] = useState<MvpStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch(bust("/api/dashboard/mvp-stats"), NO_STORE);
      const json = (await res.json()) as MvpStats & { error?: string; details?: string };
      if (!res.ok) {
        throw new Error(json.details || json.error || `HTTP ${res.status}`);
      }
      setStats(json);
    } catch (e) {
      if (!quiet) {
        setError(e instanceof Error ? e.message : "Failed to load dashboard");
        setStats(null);
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  return (
    <div className="min-h-screen text-slate-900">
      <header className="relative mb-8 overflow-hidden rounded-[28px] border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/40 to-white p-6 shadow-sm md:p-8">
        <div className="pointer-events-none absolute -bottom-16 right-0 h-40 w-40 rounded-full bg-emerald-100/35 blur-3xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">
              CloseOS operator
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 md:text-4xl">
              Today at a glance
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
              Revenue signals, inbox attention, and recovery queue — one screen before you dive
              into work. Nothing sends without your approval.
            </p>
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(false)}
            className="self-start rounded-full border border-emerald-600 bg-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {stats?.generatedAt ? (
          <p className="relative mt-3 text-xs text-slate-500">
            Updated {new Date(stats.generatedAt).toLocaleString()}
          </p>
        ) : null}
      </header>

      {error ? (
        <div
          className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void load(false)}
            className="mt-2 rounded-full border border-red-200 bg-white px-3 py-1 text-xs font-semibold text-red-700 hover:bg-red-100"
          >
            Retry
          </button>
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard
          eyebrow="Opportunities"
          count={loading && !stats ? null : (stats?.opportunityCount ?? 0)}
          label="Open revenue signals"
          href="/opportunities"
          cta="View opportunities"
          emptyHint="Run a sync to surface Whoosh and Square signals."
        />
        <StatCard
          eyebrow="Inbox"
          count={loading && !stats ? null : (stats?.inboxAttentionCount ?? 0)}
          label="Needs your attention"
          href="/messages"
          cta="Open inbox"
          emptyHint="No conversations waiting — check back after inbound SMS."
        />
        <StatCard
          eyebrow="Recovery"
          count={loading && !stats ? null : (stats?.recoveryQueueCount ?? 0)}
          label="Recovery queue"
          href="/revenue-recovery"
          cta="Open recovery workspace"
          emptyHint="No cancelled or inactive recovery targets yet."
        />
      </section>

      {!loading &&
      stats &&
      stats.opportunityCount === 0 &&
      stats.inboxAttentionCount === 0 &&
      stats.recoveryQueueCount === 0 ? (
        <p className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center text-sm text-slate-600">
          Dashboard is clear. Connect Square and Sent.dm, then refresh after your first sync.
        </p>
      ) : null}
    </div>
  );
}
