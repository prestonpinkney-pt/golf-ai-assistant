import { redirect } from "next/navigation";
import { getPrimaryBusinessIdForUser } from "@/app/api/lib/require-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { resolveBusinessMessagingConfigFromDb } from "@/lib/business-messaging-config";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/admin";
import {
  MessagingConfigForm,
  type MessagingConfigFormData,
} from "./messaging-config-form";

type MessagingNumberRow = {
  phone_number: string | null;
};

export default async function SettingsPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/settings");
  }

  const businessId = await getPrimaryBusinessIdForUser(user.id);
  if (!businessId) {
    redirect("/unauthorized");
  }

  const admin = createSupabaseServiceRoleClient();
  const config = await resolveBusinessMessagingConfigFromDb(admin, {
    businessId,
  });

  const { data: numberRows } = await admin
    .from("business_messaging_numbers")
    .select("phone_number")
    .eq("business_id", config.id)
    .eq("active", true)
    .order("created_at", { ascending: true });

  const phoneNumbers = ((numberRows ?? []) as MessagingNumberRow[])
    .map((row) => row.phone_number?.trim())
    .filter((phone): phone is string => Boolean(phone));

  const initialConfig: MessagingConfigFormData = {
    businessId: config.id,
    slug: config.slug,
    name: config.name,
    websiteDomain: config.websiteDomain,
    assistantName: config.assistantName,
    smsFromNumber: config.smsFromNumber ?? "",
    supportResponse: config.supportResponse,
    afterHoursResponse: config.afterHoursResponse,
    menuResponse: config.menuResponse,
    optOutResponse: config.optOutResponse,
    optInResponse: config.optInResponse ?? "",
    aiSourceOfTruth: config.aiSourceOfTruth,
    businessTimezone: config.businessTimezone ?? "",
    supportWeekdays: config.supportWeekdays ?? [1, 2, 3, 4, 5],
    supportOpenLocal: config.supportOpenLocal ?? "",
    supportCloseLocal: config.supportCloseLocal ?? "",
    autoSendEnabled: config.autoSendEnabled,
    minConfidence: config.minConfidence,
    maxSmsLength: config.maxSmsLength,
    phoneNumbers,
    riskyInboundTermsText: config.riskyInboundTerms.join("\n"),
    riskyResponseTermsText: config.riskyResponseTerms.join("\n"),
  };

  return (
    <div className="space-y-6">
      <section className="motion-card rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
          Business setup
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
          Messages &amp; your business
        </h1>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
          Set how your facility appears in texts, which number you send from, and the
          replies guests get when they need help or opt out.
        </p>
      </section>

      <section className="motion-card rounded-3xl border border-emerald-100 bg-gradient-to-br from-white to-emerald-50/25 p-6 shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">
          Messaging readiness
        </p>
        <h2 className="mt-2 text-xl font-semibold text-slate-900">
          Connection &amp; compliance
        </h2>
        <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Channel</dt>
            <dd className="mt-1 font-semibold capitalize text-slate-900">{config.messagingProvider}</dd>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Sender number</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-slate-900">
              {config.smsFromNumber?.trim() || "— configure in form below"}
            </dd>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:col-span-2 lg:col-span-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Business site</dt>
            <dd className="mt-1 font-medium text-slate-900">{config.websiteDomain}</dd>
          </div>
        </dl>
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Webhook URLs</p>
          <p className="mt-2 text-sm text-slate-600">
            If your messaging vendor asks for webhooks, use these paths on your live site
            (no passwords in the link).
          </p>
          <ul className="mt-3 space-y-2 font-mono text-xs text-slate-800">
            <li>
              <span className="text-slate-500">Primary: </span>
              <code className="rounded bg-slate-50 px-1.5 py-0.5">/api/sentdm/webhook</code>
            </li>
            <li>
              <span className="text-slate-500">Legacy alias: </span>
              <code className="rounded bg-slate-50 px-1.5 py-0.5">/api/webhooks/sent</code>
            </li>
          </ul>
        </div>
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">
            Background jobs (server)
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Vercel Cron drains inbound webhook work using{" "}
            <code className="rounded bg-slate-50 px-1.5 py-0.5">CRON_SECRET</code>{" "}
            (project env only). Optional ops override:{" "}
            <code className="rounded bg-slate-50 px-1.5 py-0.5">CLOSEOS_WEBHOOK_JOB_SECRET</code>.
          </p>
          <ul className="mt-3 space-y-2 font-mono text-xs text-slate-800">
            <li>
              <span className="text-slate-500">Webhook drain: </span>
              <code className="rounded bg-slate-50 px-1.5 py-0.5">/api/cron/process-webhook-jobs</code>
            </li>
          </ul>
        </div>
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-600">Compliance checklist</p>
          <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-relaxed text-slate-600">
            <li>Public <strong className="font-semibold text-slate-800">privacy policy</strong> covering SMS, retention, and opt-out</li>
            <li>Terms of service for marketing / transactional SMS where required</li>
            <li>Clear <strong className="font-semibold text-slate-800">opt-in language</strong> at collection (no silent imports)</li>
            <li><strong className="font-semibold text-slate-800">STOP</strong> / HELP / subscriber help flows honored within carrier guidelines</li>
            <li><strong className="font-semibold text-slate-800">Website &amp; brand</strong> alignment so messages match the domain customers expect</li>
          </ul>
          <p className="mt-3 text-xs text-slate-500">
            API keys stay on the server — not in the browser or in webhook URLs.
          </p>
        </div>
      </section>

      <MessagingConfigForm initialConfig={initialConfig} />
    </div>
  );
}
