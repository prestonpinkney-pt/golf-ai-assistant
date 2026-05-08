"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type RevenueSummary = {
  actualRevenueCents: number;
  businessName: string;
};

const navItems = [
  { label: "Overview", href: "/dashboard", icon: "OV" },
  { label: "Conversations", href: "/conversations", icon: "CN" },
  { label: "Opportunities", href: "/opportunities", icon: "OP" },
  { label: "Campaigns", href: "/outbound", icon: "CP" },
  { label: "Contacts", href: "/opportunities?view=contacts", icon: "CT" },
  { label: "Analytics", href: "/dashboard?view=analytics", icon: "AN" },
  { label: "Playbooks", href: "/opportunities?view=playbooks", icon: "PB" },
  { label: "Settings", href: "/settings", icon: "ST" },
];

function formatCurrencyFromCents(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format((value || 0) / 100);
}

export function Sidebar() {
  const pathname = usePathname();
  const [summary, setSummary] = useState<RevenueSummary | null>(null);

  useEffect(() => {
    let mounted = true;

    async function loadRevenueSummary() {
      try {
        const res = await fetch(`/api/revenue/summary?_=${Date.now()}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!res.ok) return;
        const json = (await res.json()) as RevenueSummary;
        if (mounted) setSummary(json);
      } catch {
        if (mounted) setSummary(null);
      }
    }

    void loadRevenueSummary();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <aside className="hidden min-h-screen w-72 shrink-0 border-r border-slate-200 bg-white lg:block">
      <div className="flex h-full flex-col">
        <div className="px-5 py-6">
          <div className="flex items-center gap-3">
            <div className="ambient-orb flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-600 text-sm font-bold text-white shadow-sm">
              C
            </div>
            <div>
              <div className="text-lg font-bold tracking-[-0.03em] text-slate-950">
                CloseOS
              </div>
              <div className="text-xs font-medium text-slate-500">
                Revenue workspace
              </div>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3">
          {navItems.map((item) => {
            const active =
              (item.label === "Overview" && pathname === "/dashboard") ||
              (item.label === "Conversations" && (pathname.startsWith("/conversations") || pathname.startsWith("/messages"))) ||
              (item.label === "Opportunities" && pathname.startsWith("/opportunities")) ||
              (item.label === "Campaigns" && pathname.startsWith("/outbound")) ||
              (item.label === "Settings" && pathname.startsWith("/settings"));

            return (
              <Link
                key={item.label}
                href={item.href}
                className={`motion-card flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                  active
                    ? "border border-emerald-200 bg-emerald-50 text-emerald-800 shadow-sm"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                }`}
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-lg text-[10px] font-bold ${
                    active ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-3 px-3 pb-4">
          <Link
            href="/dashboard"
            className="motion-card block rounded-2xl border border-emerald-200 bg-emerald-50 p-4 transition hover:bg-emerald-100"
          >
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
              <span className="live-dot h-2 w-2 rounded-full bg-emerald-500 text-emerald-500" />
              AI Revenue Generated
            </div>
            <div className="mt-3 text-2xl font-semibold tracking-[-0.05em] text-slate-950">
              {summary ? formatCurrencyFromCents(summary.actualRevenueCents) : "Live"}
            </div>
            <div className="mt-1 text-xs font-semibold text-emerald-700">
              This month
            </div>
          </Link>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white">
                PG
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-950">
                  {summary?.businessName ?? "Primetime Golf"}
                </div>
                <div className="text-xs text-slate-500">Workspace owner</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}