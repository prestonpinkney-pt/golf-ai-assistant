"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CAMPAIGNS_SETUP_MESSAGE } from "@/app/api/campaigns/setup-copy";
import { campaignBatchExecutionLabel } from "@/lib/operator-ui-copy";

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  total_recipients: number;
  total_drafted: number;
  total_approved: number;
  total_sent: number;
  total_failed: number;
  created_at: string;
  updated_at: string;
};

const NO_STORE: RequestInit = {
  cache: "no-store",
  credentials: "include",
  headers: { "Cache-Control": "no-cache" },
};

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function OutboundCampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSetupMessage(null);
    try {
      const res = await fetch(`/api/campaigns?_=${Date.now()}`, NO_STORE);
      const json = (await res.json()) as {
        campaigns?: CampaignRow[];
        setupRequired?: boolean;
        setupMessage?: string;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      if (json.setupRequired) {
        setSetupMessage(json.setupMessage ?? CAMPAIGNS_SETUP_MESSAGE);
        setCampaigns([]);
        return;
      }
      setCampaigns(Array.isArray(json.campaigns) ? json.campaigns : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="text-slate-900">
      <section className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/30 to-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">
          Outbound campaigns
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
          Review, approve, then send
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
          Agent-drafted SMS batches from opportunity targets. Nothing sends until you approve
          each message and click send. Set{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            CLOSEOS_TEST_SMS_ALLOWLIST
          </code>{" "}
          in staging to restrict recipients.
        </p>
      </section>

      {loading ? (
        <p className="mt-6 text-sm text-slate-500">Loading campaigns…</p>
      ) : error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : setupMessage ? (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {setupMessage}
        </div>
      ) : campaigns.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center text-sm text-slate-600">
          No campaigns yet. Create one from{" "}
          <Link href="/opportunities" className="font-semibold text-emerald-800 underline">
            Opportunities
          </Link>
          .
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {campaigns.map((c) => (
            <li key={c.id}>
              <Link
                href={`/outbound/${c.id}`}
                className="block rounded-xl border border-slate-200/90 bg-white p-4 shadow-sm transition hover:border-emerald-200 hover:shadow-md"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-900">{c.name}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {c.total_recipients} recipients · {c.total_drafted} draft ·{" "}
                      {c.total_approved} approved · {c.total_sent} sent
                      {c.total_failed ? ` · ${c.total_failed} failed` : ""}
                    </p>
                  </div>
                  <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-bold uppercase text-slate-700">
                    {campaignBatchExecutionLabel(c.status)}
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  Updated {formatWhen(c.updated_at)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
