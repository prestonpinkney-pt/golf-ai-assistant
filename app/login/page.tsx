import { Suspense } from "react";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.14),transparent_28%),linear-gradient(180deg,#f8fafc_0%,#f1f5f9_100%)] px-4">
      <div className="w-full max-w-md motion-card rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-600 text-sm font-bold text-white shadow-sm">
            C
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-[-0.03em] text-slate-950">CloseOS</h1>
            <p className="text-sm text-slate-600">Sign in to the Primetime revenue workspace</p>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Operator controlled
          </p>
          <p className="mt-2 text-sm leading-6 text-emerald-900/75">
            Review opportunities, approve drafts, and monitor revenue progress from one secure workspace.
          </p>
        </div>

        <Suspense fallback={<p className="mt-6 text-sm text-slate-500">Loading…</p>}>
          <LoginForm />
        </Suspense>
      </div>
    </div>
  );
}
