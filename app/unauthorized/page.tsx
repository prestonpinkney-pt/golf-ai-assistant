import Link from "next/link";

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md rounded-xl border border-amber-200 bg-amber-50 p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-amber-950">Access denied</h1>
        <p className="mt-2 text-sm text-amber-900">
          You do not have access to this CloseOS workspace.
        </p>
        <p className="mt-3 text-xs text-amber-800">
          Ask a workspace owner to add your account in Supabase <code className="rounded bg-white px-1">business_users</code>.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-950 hover:bg-amber-100"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
