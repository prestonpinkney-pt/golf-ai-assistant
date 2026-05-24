"use client";

import { useState } from "react";

export type MessagingConfigFormData = {
  businessId: string;
  slug: string;
  name: string;
  websiteDomain: string;
  assistantName: string;
  smsFromNumber: string;
  supportResponse: string;
  afterHoursResponse: string;
  menuResponse: string;
  optOutResponse: string;
  optInResponse: string;
  aiSourceOfTruth: string;
  businessTimezone: string;
  supportWeekdays: number[];
  supportOpenLocal: string;
  supportCloseLocal: string;
  autoSendEnabled: boolean;
  minConfidence: number;
  maxSmsLength: number;
  phoneNumbers: string[];
  riskyInboundTermsText: string;
  riskyResponseTermsText: string;
};

function splitTerms(text: string): string[] {
  return text
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function fieldClassName() {
  return "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20";
}

function labelClassName() {
  return "text-xs font-semibold uppercase tracking-wide text-slate-600";
}

export function MessagingConfigForm({
  initialConfig,
}: {
  initialConfig: MessagingConfigFormData;
}) {
  const [form, setForm] = useState(initialConfig);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("saving");
    setError(null);

    const phoneNumbers = [
      ...new Set(
        [form.smsFromNumber.trim(), ...form.phoneNumbers.map((p) => p.trim())].filter(Boolean)
      ),
    ];

    const res = await fetch("/api/business-messaging/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId: form.businessId,
        slug: form.slug,
        name: form.name,
        websiteDomain: form.websiteDomain,
        assistantName: form.assistantName,
        smsFromNumber: form.smsFromNumber,
        supportResponse: form.supportResponse,
        afterHoursResponse: form.afterHoursResponse,
        menuResponse: form.menuResponse,
        optOutResponse: form.optOutResponse,
        optInResponse: form.optInResponse,
        aiSourceOfTruth: form.aiSourceOfTruth,
        businessTimezone: form.businessTimezone || null,
        supportWeekdays: form.supportWeekdays,
        supportOpenLocal: form.supportOpenLocal || null,
        supportCloseLocal: form.supportCloseLocal || null,
        autoSendEnabled: form.autoSendEnabled,
        minConfidence: form.minConfidence,
        maxSmsLength: form.maxSmsLength,
        phoneNumbers,
        riskyInboundTerms: splitTerms(form.riskyInboundTermsText),
        riskyResponseTerms: splitTerms(form.riskyResponseTermsText),
      }),
    });

    const data = (await res.json().catch(() => ({}))) as { error?: string; success?: boolean };

    if (!res.ok || !data.success) {
      setStatus("error");
      setError(data.error ?? `Save failed (${res.status})`);
      return;
    }

    setStatus("saved");
    setTimeout(() => setStatus("idle"), 3000);
  }

  return (
    <form
      onSubmit={onSubmit}
      className="motion-card space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8"
    >
      <div>
        <p className={labelClassName()}>Configuration</p>
        <h2 className="mt-1 text-xl font-semibold text-slate-900">Edit messaging settings</h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className={labelClassName()}>Business name</span>
          <input
            className={fieldClassName()}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>Slug</span>
          <input
            className={fieldClassName()}
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value })}
            required
          />
        </label>
        <label className="block md:col-span-2">
          <span className={labelClassName()}>Website domain</span>
          <input
            className={fieldClassName()}
            value={form.websiteDomain}
            onChange={(e) => setForm({ ...form, websiteDomain: e.target.value })}
            required
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>Assistant name</span>
          <input
            className={fieldClassName()}
            value={form.assistantName}
            onChange={(e) => setForm({ ...form, assistantName: e.target.value })}
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>SMS from (E.164)</span>
          <input
            className={fieldClassName()}
            value={form.smsFromNumber}
            onChange={(e) => setForm({ ...form, smsFromNumber: e.target.value })}
            placeholder="+15551234567"
          />
        </label>
      </div>

      <label className="block">
        <span className={labelClassName()}>AI source of truth</span>
        <textarea
          className={`${fieldClassName()} min-h-[120px] font-mono text-xs`}
          value={form.aiSourceOfTruth}
          onChange={(e) => setForm({ ...form, aiSourceOfTruth: e.target.value })}
          required
        />
      </label>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className={labelClassName()}>Support response</span>
          <textarea
            className={`${fieldClassName()} min-h-[80px]`}
            value={form.supportResponse}
            onChange={(e) => setForm({ ...form, supportResponse: e.target.value })}
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>After hours</span>
          <textarea
            className={`${fieldClassName()} min-h-[80px]`}
            value={form.afterHoursResponse}
            onChange={(e) => setForm({ ...form, afterHoursResponse: e.target.value })}
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>Menu response</span>
          <textarea
            className={`${fieldClassName()} min-h-[80px]`}
            value={form.menuResponse}
            onChange={(e) => setForm({ ...form, menuResponse: e.target.value })}
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>Opt-out / opt-in</span>
          <textarea
            className={`${fieldClassName()} min-h-[40px]`}
            value={form.optOutResponse}
            onChange={(e) => setForm({ ...form, optOutResponse: e.target.value })}
            placeholder="STOP reply"
          />
          <textarea
            className={`${fieldClassName()} mt-2 min-h-[40px]`}
            value={form.optInResponse}
            onChange={(e) => setForm({ ...form, optInResponse: e.target.value })}
            placeholder="Opt-in confirmation"
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label className="block">
          <span className={labelClassName()}>Timezone (IANA)</span>
          <input
            className={fieldClassName()}
            value={form.businessTimezone}
            onChange={(e) => setForm({ ...form, businessTimezone: e.target.value })}
            placeholder="America/Los_Angeles"
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>Support open</span>
          <input
            className={fieldClassName()}
            value={form.supportOpenLocal}
            onChange={(e) => setForm({ ...form, supportOpenLocal: e.target.value })}
            placeholder="09:00"
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>Support close</span>
          <input
            className={fieldClassName()}
            value={form.supportCloseLocal}
            onChange={(e) => setForm({ ...form, supportCloseLocal: e.target.value })}
            placeholder="17:00"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={form.autoSendEnabled}
            onChange={(e) => setForm({ ...form, autoSendEnabled: e.target.checked })}
          />
          Auto-send enabled
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          Min confidence
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            className="w-20 rounded-lg border border-slate-200 px-2 py-1"
            value={form.minConfidence}
            onChange={(e) =>
              setForm({ ...form, minConfidence: Number.parseFloat(e.target.value) || 0 })
            }
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          Max SMS length
          <input
            type="number"
            min={1}
            className="w-24 rounded-lg border border-slate-200 px-2 py-1"
            value={form.maxSmsLength}
            onChange={(e) =>
              setForm({ ...form, maxSmsLength: Number.parseInt(e.target.value, 10) || 600 })
            }
          />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className={labelClassName()}>Risky inbound terms (one per line)</span>
          <textarea
            className={`${fieldClassName()} min-h-[100px] font-mono text-xs`}
            value={form.riskyInboundTermsText}
            onChange={(e) => setForm({ ...form, riskyInboundTermsText: e.target.value })}
          />
        </label>
        <label className="block">
          <span className={labelClassName()}>Risky response terms (one per line)</span>
          <textarea
            className={`${fieldClassName()} min-h-[100px] font-mono text-xs`}
            value={form.riskyResponseTermsText}
            onChange={(e) => setForm({ ...form, riskyResponseTermsText: e.target.value })}
          />
        </label>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      {status === "saved" ? (
        <p className="text-sm text-emerald-700">Settings saved.</p>
      ) : null}

      <button
        type="submit"
        disabled={status === "saving"}
        className="rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
      >
        {status === "saving" ? "Saving…" : "Save settings"}
      </button>
    </form>
  );
}
