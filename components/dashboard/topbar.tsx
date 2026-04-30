import { SignOutButton } from "./sign-out-button";

export function Topbar() {
  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div>
        <div className="text-sm font-semibold text-slate-950">
          Revenue Command
        </div>
        <div className="text-xs text-slate-500">
          Launch-ready CloseOS workspace
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
          Messaging Pending Approval
        </div>

        <SignOutButton />

        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-950 text-sm font-semibold text-white">
          P
        </div>
      </div>
    </header>
  );
}