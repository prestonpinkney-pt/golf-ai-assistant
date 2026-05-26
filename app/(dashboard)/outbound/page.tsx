"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { CampaignFocus } from "@/lib/campaigns/campaign-focus";
import {
  formatCampaignsErrorBanner,
  formatCampaignsSetupBanner,
  resolveCampaignsListUiState,
  type CampaignRow,
} from "@/lib/campaigns/campaigns-ui-state";
import { campaignBatchExecutionLabel } from "@/lib/operator-ui-copy";

const NO_STORE: RequestInit = {
  cache: "no-store",
  credentials: "include",
  headers: { "Cache-Control": "no-cache" },
};

const GENERATE_BUTTON_CLASS =
  "inline-flex items-center justify-center rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50";

const NO_TARGETS_NOTICE =
  "No eligible campaign targets found yet. Run Square sync and revenue recovery first.";

const CAMPAIGN_FOCUS_OPTIONS: { value: CampaignFocus; label: string }[] = [
  { value: "best", label: "Best Opportunity" },
  { value: "simulator", label: "Fill Simulator Time" },
  { value: "slow_time", label: "Fill Slow Times" },
  { value: "lessons", label: "Lessons" },
  { value: "memberships", label: "Memberships" },
  { value: "events", label: "Events" },
];

const WHOOSH_NOT_CONFIGURED =
  "Connect Whoosh availability before generating slow-time campaigns.";

const WHOOSH_SYNC_FAILED =
  "Whoosh availability could not be verified. CloseOS will not generate slow-time campaigns until availability is confirmed.";

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function OutboundCampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupMessage, setSetupMessage] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [campaignFocus, setCampaignFocus] = useState<CampaignFocus>("best");
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateNotice, setGenerateNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSetupMessage(null);
    try {
      const res = await fetch(`/api/campaigns?_=${Date.now()}`, NO_STORE);
      const json = (await res.json()) as Parameters<
        typeof resolveCampaignsListUiState
      >[1];
      const state = resolveCampaignsListUiState(res.ok, json);

      setCampaigns(state.campaigns);
      setSetupMessage(
        state.setupMessage ? formatCampaignsSetupBanner(state) : null
      );
      setError(state.error ? formatCampaignsErrorBanner(state) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, []);

  async function syncWhooshAvailability(): Promise<
    | { ok: true }
    | { ok: false; message: string }
  > {
    const res = await fetch(`/api/whoosh/availability/sync?_=${Date.now()}`, {
      ...NO_STORE,
      method: "POST",
    });

    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      message?: string;
    };

    if (data.error === "whoosh_not_configured") {
      return { ok: false, message: WHOOSH_NOT_CONFIGURED };
    }

    if (!res.ok || data.ok === false) {
      if (data.error === "whoosh_sync_failed" || data.error === "no_whoosh_windows") {
        return { ok: false, message: WHOOSH_SYNC_FAILED };
      }
      return {
        ok: false,
        message: data.message ?? WHOOSH_SYNC_FAILED,
      };
    }

    return { ok: true };
  }

  async function generateCampaign() {
    setGenerating(true);
    setGenerateError(null);
    setGenerateNotice(null);

    try {
      if (campaignFocus === "slow_time") {
        const sync = await syncWhooshAvailability();
        if (!sync.ok) {
          setGenerateError(sync.message);
          return;
        }
      }

      const res = await fetch(`/api/campaigns/generate?_=${Date.now()}`, {
        ...NO_STORE,
        method: "POST",
        headers: {
          ...NO_STORE.headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          campaignFocus,
          maxTargets: campaignFocus === "slow_time" ? 25 : undefined,
        }),
      });

      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        errorCode?: string;
        message?: string;
        emptyReason?: string;
        setupRequired?: boolean;
        setupMessage?: string;
        debugError?: string;
        campaign?: { id?: string };
        campaign_id?: string | null;
      };

      if (json.error === "whoosh_availability_required" || json.errorCode === "whoosh_availability_required") {
        setGenerateError(
          json.message ??
            "Whoosh availability is required before generating slow-time campaigns."
        );
        return;
      }

      if (json.setupRequired) {
        const msg = json.setupMessage ?? json.message ?? "Campaign setup required";
        setSetupMessage(msg);
        if (json.debugError && process.env.NODE_ENV === "development") {
          setGenerateError(`${msg} — ${json.debugError}`);
        }
        return;
      }

      if (!res.ok) {
        if (json.error === "no_targets") {
          setGenerateNotice(json.emptyReason ?? NO_TARGETS_NOTICE);
          return;
        }
        const msg = json.message ?? json.error ?? `HTTP ${res.status}`;
        throw new Error(
          json.debugError && process.env.NODE_ENV === "development"
            ? `${msg} — ${json.debugError}`
            : msg
        );
      }

      const id = json.campaign?.id ?? json.campaign_id;
      if (id) {
        router.push(`/outbound/${id}`);
        return;
      }

      await load();
    } catch (e) {
      setGenerateError(
        e instanceof Error ? e.message : "Failed to generate campaign"
      );
    } finally {
      setGenerating(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  const generateButton = (
    <button
      type="button"
      onClick={() => void generateCampaign()}
      disabled={generating}
      className={GENERATE_BUTTON_CLASS}
    >
      {generating
        ? campaignFocus === "slow_time"
          ? "Syncing Whoosh…"
          : "Generating…"
        : campaignFocus === "slow_time"
          ? "Sync & Generate"
          : "Generate Campaign"}
    </button>
  );

  const focusControl = (
    <label className="flex flex-col gap-1 text-sm text-slate-700">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Campaign focus
      </span>
      <select
        value={campaignFocus}
        onChange={(e) => setCampaignFocus(e.target.value as CampaignFocus)}
        disabled={generating}
        className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200 disabled:opacity-50"
      >
        {CAMPAIGN_FOCUS_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <main className="text-slate-900">
      <section className="rounded-2xl border border-emerald-100 bg-gradient-to-br from-white via-emerald-50/30 to-white p-6 shadow-sm md:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">
              Outbound campaigns
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
              Review, approve, then send
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
              AI-drafted SMS batches from opportunity intelligence. Nothing sends until you
              approve each message and click send. Set{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                CLOSEOS_TEST_SMS_ALLOWLIST
              </code>{" "}
              in staging to restrict recipients.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:items-end">
            {focusControl}
            {generateButton}
          </div>
        </div>
      </section>

      {generateError ? (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {generateError}
        </div>
      ) : null}

      {generateNotice ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          {generateNotice}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-6 text-sm text-slate-500">Loading campaigns…</p>
      ) : error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : setupMessage ? (
        <div className="mt-6 space-y-4">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            {setupMessage}
          </div>
          <div className="flex flex-wrap gap-3">
            {generateButton}
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Retry load
            </button>
          </div>
        </div>
      ) : campaigns.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center">
          <p className="text-sm text-slate-600">
            No campaigns yet. Generate a draft campaign from your highest-priority opportunities,
            then review and approve each message before anything sends.
          </p>
          <div className="mt-5 flex justify-center">{generateButton}</div>
        </div>
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
