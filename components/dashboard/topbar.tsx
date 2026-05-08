"use client";

import { usePathname } from "next/navigation";
import { SignOutButton } from "./sign-out-button";

const pageCopy: Record<string, { title: string; subtitle: string }> = {
  "/dashboard": {
    title: "Overview",
    subtitle: "AI revenue operating system for golf businesses.",
  },
  "/opportunities": {
    title: "Opportunities",
    subtitle: "Prioritized revenue motions ready for review.",
  },
  "/outbound": {
    title: "Campaigns",
    subtitle: "Draft, review, and launch approved outreach.",
  },
  "/messages": {
    title: "Conversations",
    subtitle: "Operator-reviewed customer messaging.",
  },
  "/conversations": {
    title: "Conversations",
    subtitle: "Operator-reviewed customer messaging.",
  },
  "/settings": {
    title: "Settings",
    subtitle: "Workspace controls and integration setup.",
  },
};

export function Topbar() {
  const pathname = usePathname();
  const copy =
    pageCopy[pathname] ??
    Object.entries(pageCopy).find(([href]) => pathname.startsWith(`${href}/`))?.[1] ??
    pageCopy["/dashboard"];

  return (
    <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-4 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur-xl sm:px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="live-dot h-2 w-2 rounded-full bg-emerald-500 text-emerald-500" />
          <div className="truncate text-sm font-semibold text-slate-950">
            {copy.title}
          </div>
        </div>
        <div className="truncate text-xs text-slate-500">
          {copy.subtitle}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="hidden rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md md:block"
        >
          This month
        </button>

        <div className="hidden items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 shadow-sm lg:flex">
          <span className="live-dot h-2 w-2 rounded-full bg-emerald-500 text-emerald-500" />
          Live sync
        </div>

        <button
          type="button"
          aria-label="Notifications"
          className="relative flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white text-xs font-bold text-slate-600 shadow-sm transition hover:-translate-y-0.5 hover:bg-slate-50 hover:shadow-md"
        >
          <span className="live-dot h-2 w-2 rounded-full bg-emerald-500 text-emerald-500" />
          <span className="sr-only">No new notifications</span>
        </button>

        <div className="hidden items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md md:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
            PG
          </div>
          <span className="text-xs font-semibold text-slate-700">Primetime Golf</span>
        </div>

        <SignOutButton />
      </div>
    </header>
  );
}